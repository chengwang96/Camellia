package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/feature"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

type command struct {
	ID        int    `json:"id"`
	Action    string `json:"action"`
	Directory string `json:"directory"`
	Key       string `json:"key"`
	Hostname  string `json:"hostname"`
	Target    string `json:"target"`
	Token     string `json:"token"`
}

type helper struct {
	node       *tsnet.Server
	proxy      *http.Server
	whoisMu    sync.Mutex
	whoisCache map[string]whoisCacheEntry
}

func proxyHandler(target, token string) (http.Handler, error) {
	return proxyHandlerWithIdentity(target, token, nil)
}

type tailnetIdentity struct {
	NodeID string
	UserID string
	Login  string
	Name   string
	Tags   []string
}

type whoisCacheEntry struct {
	identity tailnetIdentity
	expires  time.Time
}

func proxyHandlerWithIdentity(target, token string, identity func(context.Context, string) (tailnetIdentity, bool)) (http.Handler, error) {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("invalid gateway target")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 || len(token) != 64 {
		return nil, errors.New("invalid gateway configuration")
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(parsed)
			request.Out.Host = request.In.Host
			if origin := request.In.Header.Get("Origin"); origin != "" {
				request.Out.Header.Set("Origin", origin)
			}
			if site := request.In.Header.Get("Sec-Fetch-Site"); site != "" {
				request.Out.Header.Set("Sec-Fetch-Site", site)
			}
			for _, name := range []string{"X-Camellia-Tailnet-Node", "X-Camellia-Tailnet-User",
				"X-Camellia-Tailnet-Login", "X-Camellia-Tailnet-Name", "X-Camellia-Tailnet-Tags"} {
				request.Out.Header.Del(name)
			}
			request.Out.Header.Set("X-Camellia-Transport", token)
			address, _, _ := net.SplitHostPort(request.In.RemoteAddr)
			request.Out.Header.Set("X-Camellia-Peer", address)
			if identity != nil {
				if peer, ok := identity(request.In.Context(), request.In.RemoteAddr); ok {
					setTailnetHeaders(request.Out.Header, peer)
				}
			}
		},
		Transport:     &http.Transport{Proxy: nil, MaxIdleConns: 64, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 15 * time.Second},
		FlushInterval: -1,
		ErrorHandler: func(response http.ResponseWriter, request *http.Request, err error) {
			http.Error(response, "Gateway unavailable", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.IsAbs() && (request.URL.Scheme != "http" || request.URL.Host != request.Host) {
			http.Error(response, "Invalid request target", http.StatusBadRequest)
			return
		}
		proxy.ServeHTTP(response, request)
	}), nil
}

func cleanHeader(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value)
	if len(value) > 512 {
		value = value[:512]
	}
	return value
}

func setTailnetHeaders(header http.Header, identity tailnetIdentity) {
	nodeID, userID := cleanHeader(identity.NodeID), cleanHeader(identity.UserID)
	if nodeID == "" || userID == "" {
		return
	}
	header.Set("X-Camellia-Tailnet-Node", nodeID)
	header.Set("X-Camellia-Tailnet-User", userID)
	if login := cleanHeader(identity.Login); login != "" {
		header.Set("X-Camellia-Tailnet-Login", login)
	}
	if name := cleanHeader(identity.Name); name != "" {
		header.Set("X-Camellia-Tailnet-Name", name)
	}
	tags := make([]string, 0, len(identity.Tags))
	for _, tag := range identity.Tags {
		if value := cleanHeader(tag); value != "" {
			tags = append(tags, value)
		}
	}
	if len(tags) > 0 {
		header.Set("X-Camellia-Tailnet-Tags", strings.Join(tags, ","))
	}
}

func (service *helper) identityFor(ctx context.Context, remoteAddr string) (tailnetIdentity, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	address, err := netip.ParseAddr(host)
	if err != nil || !netip.MustParsePrefix("100.64.0.0/10").Contains(address) {
		return tailnetIdentity{}, false
	}
	now := time.Now()
	service.whoisMu.Lock()
	cached, ok := service.whoisCache[host]
	service.whoisMu.Unlock()
	if ok && now.Before(cached.expires) {
		return cached.identity, true
	}
	if service.node == nil {
		return tailnetIdentity{}, false
	}
	client, err := service.node.LocalClient()
	if err != nil {
		return tailnetIdentity{}, false
	}
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	who, err := client.WhoIs(callCtx, remoteAddr)
	if err != nil || who.Node == nil || who.UserProfile == nil {
		return tailnetIdentity{}, false
	}
	// A shared node is authenticated as its owner, not as the person it was
	// shared with. Do not turn a share into tailnet trust; that device can use
	// the explicit pairing-code flow instead.
	if who.Node.Sharer != 0 {
		return tailnetIdentity{}, false
	}
	identity := tailnetIdentity{
		NodeID: string(who.Node.StableID),
		UserID: strconv.FormatUint(uint64(who.Node.User), 10),
		Login:  who.UserProfile.LoginName,
		Name:   who.Node.Name,
		Tags:   append([]string(nil), who.Node.Tags...),
	}
	if identity.NodeID == "" || identity.UserID == "" {
		return tailnetIdentity{}, false
	}
	service.whoisMu.Lock()
	if service.whoisCache == nil {
		service.whoisCache = map[string]whoisCacheEntry{}
	}
	if len(service.whoisCache) >= 256 {
		for key, entry := range service.whoisCache {
			if now.After(entry.expires) {
				delete(service.whoisCache, key)
			}
		}
		if len(service.whoisCache) >= 256 {
			clear(service.whoisCache)
		}
	}
	service.whoisCache[host] = whoisCacheEntry{identity: identity, expires: now.Add(5 * time.Minute)}
	service.whoisMu.Unlock()
	return identity, true
}

func statusResult(status *ipnstate.Status) map[string]any {
	address := ""
	for _, candidate := range status.TailscaleIPs {
		if candidate.Is4() && netip.MustParsePrefix("100.64.0.0/10").Contains(candidate) {
			address = candidate.String()
			break
		}
	}
	deviceID, hostName, online := "", "", false
	selfUserID, selfLogin, selfDisplay := "", "", ""
	if status.Self != nil {
		deviceID, hostName, online = string(status.Self.ID), status.Self.HostName, status.Self.Online
		selfUserID = strconv.FormatUint(uint64(status.Self.UserID), 10)
		if profile, ok := status.User[status.Self.UserID]; ok {
			selfLogin, selfDisplay = profile.LoginName, profile.DisplayName
		}
	}
	health := status.Health
	if health == nil {
		health = []string{}
	}
	return map[string]any{"state": status.BackendState, "loginUrl": status.AuthURL, "address": address,
		"deviceId": deviceID, "hostName": hostName, "online": online, "health": health,
		"selfUserId": selfUserID, "selfLoginName": selfLogin, "selfDisplayName": selfDisplay}
}

func (service *helper) execute(request command) (any, error) {
	if request.Action == "init" {
		if service.node != nil || !filepath.IsAbs(request.Directory) {
			return nil, errors.New("invalid initialization")
		}
		if feature.Registered()["useproxy"] {
			return nil, errors.New("embedded network must not use a system proxy")
		}
		hostname, err := nodeHostname(request.Hostname)
		if err != nil {
			return nil, err
		}
		key, err := base64.StdEncoding.DecodeString(request.Key)
		if err != nil {
			return nil, errors.New("invalid storage key")
		}
		store, err := newStore(request.Directory, key)
		if err != nil {
			return nil, err
		}
		quiet := func(string, ...any) {}
		service.node = &tsnet.Server{Dir: request.Directory, Hostname: hostname, Store: store, Logf: quiet, UserLogf: quiet}
		if err := service.node.Start(); err != nil {
			return nil, err
		}
		return map[string]any{"state": "Starting"}, nil
	}
	if service.node == nil {
		return nil, errors.New("network not initialized")
	}
	client, err := service.node.LocalClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	switch request.Action {
	case "diagnose-peer":
		return probePeer(ctx, client, request.Target)
	case "status":
		status, err := client.StatusWithoutPeers(ctx)
		if err != nil {
			return nil, err
		}
		return statusResult(status), nil
	case "set-hostname":
		hostname, err := nodeHostname(request.Hostname)
		if err != nil {
			return nil, err
		}
		if _, err := client.EditPrefs(ctx, &ipn.MaskedPrefs{HostnameSet: true, Prefs: ipn.Prefs{Hostname: hostname}}); err != nil {
			return nil, err
		}
		return map[string]any{"hostName": hostname}, nil
	case "login":
		return nil, client.StartLoginInteractive(ctx)
	case "logout":
		return nil, client.Logout(ctx)
	case "listen":
		handler, err := proxyHandlerWithIdentity(request.Target, request.Token, service.identityFor)
		if err != nil {
			return nil, err
		}
		if service.proxy != nil {
			if err := service.proxy.Close(); err != nil {
				return nil, err
			}
			service.proxy = nil
		}
		listener, err := service.node.Listen("tcp", ":43127")
		if err != nil {
			return nil, err
		}
		proxy := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
		service.proxy = proxy
		go func() {
			if err := proxy.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				os.Exit(1)
			}
		}()
		return nil, nil
	default:
		return nil, errors.New("unsupported network action")
	}
}

func main() {
	os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	service := &helper{}
	defer func() {
		if service.proxy != nil {
			service.proxy.Close()
		}
		if service.node != nil {
			service.node.Close()
		}
	}()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request command
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			return
		}
		result, err := service.execute(request)
		response := map[string]any{"id": request.ID, "result": result}
		if err != nil {
			response["error"] = fmt.Sprint(err)
		}
		if encoder.Encode(response) != nil {
			return
		}
	}
}
