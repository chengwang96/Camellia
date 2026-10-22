package main

import (
	"context"
	"errors"
	"math"
	"net/netip"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

type diagnosticClient interface {
	Ping(context.Context, netip.Addr, tailcfg.PingType) (*ipnstate.PingResult, error)
	CurrentDERPMap(context.Context) (*tailcfg.DERPMap, error)
}

type pathProbe struct {
	CheckedAt      int64    `json:"checkedAt"`
	PeerAddress    string   `json:"peerAddress"`
	Path           string   `json:"path"`
	LatencyMs      *float64 `json:"latencyMs"`
	Endpoint       string   `json:"endpoint,omitempty"`
	PeerRelay      string   `json:"peerRelay,omitempty"`
	DERPRegionID   int      `json:"derpRegionId,omitempty"`
	DERPRegionCode string   `json:"derpRegionCode,omitempty"`
	DERPRegionName string   `json:"derpRegionName,omitempty"`
}

// Use a disco ping result, rather than a peer's home DERP region: peers retain
// that region even when application traffic is going directly over UDP.
func probePeer(ctx context.Context, client diagnosticClient, target string) (pathProbe, error) {
	address, err := netip.ParseAddr(target)
	if err != nil || !netip.MustParsePrefix("100.64.0.0/10").Contains(address) {
		return pathProbe{}, errors.New("invalid diagnostic peer address")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	result, pingErr := client.Ping(ctx, address, tailcfg.PingDisco)
	probe := pathProbe{CheckedAt: time.Now().UnixMilli(), PeerAddress: address.String(), Path: "unreachable"}
	if pingErr != nil || result == nil || result.Err != "" || result.IsLocalIP {
		return probe, nil
	}
	probe.Path = "unknown"
	if !math.IsNaN(result.LatencySeconds) && !math.IsInf(result.LatencySeconds, 0) && result.LatencySeconds >= 0 {
		latency := math.Round(result.LatencySeconds*1e6) / 1e3
		probe.LatencyMs = &latency
	}
	switch {
	case result.PeerRelay != "":
		probe.Path, probe.PeerRelay = "peer-relay", result.PeerRelay
	case result.DERPRegionID != 0:
		probe.Path, probe.DERPRegionID, probe.DERPRegionCode = "derp", result.DERPRegionID, result.DERPRegionCode
		if regions, err := client.CurrentDERPMap(ctx); err == nil && regions != nil {
			if region := regions.Regions[result.DERPRegionID]; region != nil {
				probe.DERPRegionName = region.RegionName
			}
		}
	case result.Endpoint != "":
		probe.Path, probe.Endpoint = "direct", result.Endpoint
	}
	return probe, nil
}
