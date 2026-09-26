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
	"time"

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
	node     *tsnet.Server
	proxy    *http.Server
	outbound map[string]*outboundConnection
}

func proxyHandler(target, token string) (http.Handler, error) {
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
			request.Out.Header.Set("X-Camellia-Transport", token)
			address, _, _ := net.SplitHostPort(request.In.RemoteAddr)
			request.Out.Header.Set("X-Camellia-Peer", address)
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

func (service *helper) execute(request command) (any, error) {
	if request.Action == "init" {
		if service.node != nil || !filepath.IsAbs(request.Directory) {
			return nil, errors.New("invalid initialization")
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
	if request.Action == "connect" {
		return service.connect(request.Target, request.Token)
	}
	if request.Action == "disconnect" {
		if connection := service.outbound[request.Token]; connection != nil {
			connection.close()
			delete(service.outbound, request.Token)
		}
		return nil, nil
	}
	client, err := service.node.LocalClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	switch request.Action {
	case "status":
		status, err := client.StatusWithoutPeers(ctx)
		if err != nil {
			return nil, err
		}
		address := ""
		for _, candidate := range status.TailscaleIPs {
			if candidate.Is4() && netip.MustParsePrefix("100.64.0.0/10").Contains(candidate) {
				address = candidate.String()
				break
			}
		}
		return map[string]any{"state": status.BackendState, "loginUrl": status.AuthURL, "address": address}, nil
	case "login":
		return nil, client.StartLoginInteractive(ctx)
	case "logout":
		service.disconnectAll()
		return nil, client.Logout(ctx)
	case "listen":
		if service.proxy != nil {
			return nil, errors.New("already listening")
		}
		handler, err := proxyHandler(request.Target, request.Token)
		if err != nil {
			return nil, err
		}
		listener, err := service.node.Listen("tcp", ":43127")
		if err != nil {
			return nil, err
		}
		service.proxy = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
		go func() {
			if err := service.proxy.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
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
		service.disconnectAll()
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
