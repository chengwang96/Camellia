package main

import (
	"context"
	"errors"
	"net/netip"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

type fakeDiagnosticClient struct {
	result *ipnstate.PingResult
	err    error
	calls  int
}

func (client *fakeDiagnosticClient) Ping(ctx context.Context, address netip.Addr, kind tailcfg.PingType) (*ipnstate.PingResult, error) {
	client.calls++
	if kind != tailcfg.PingDisco || address.String() != "100.90.1.2" {
		return nil, errors.New("wrong probe destination or protocol")
	}
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 3*time.Second {
		return nil, errors.New("missing bounded probe deadline")
	}
	return client.result, client.err
}

func (client *fakeDiagnosticClient) CurrentDERPMap(context.Context) (*tailcfg.DERPMap, error) {
	return &tailcfg.DERPMap{Regions: map[int]*tailcfg.DERPRegion{17: {RegionName: "Los Angeles"}}}, nil
}

func TestDiagnosticPathsComeFromDiscoResults(t *testing.T) {
	for _, test := range []struct {
		name, path string
		result     *ipnstate.PingResult
		err        error
	}{
		{"direct", "direct", &ipnstate.PingResult{Endpoint: "203.0.113.4:41641", LatencySeconds: .02125}, nil},
		{"derp", "derp", &ipnstate.PingResult{DERPRegionID: 17, DERPRegionCode: "lax", LatencySeconds: .4}, nil},
		{"peer relay", "peer-relay", &ipnstate.PingResult{PeerRelay: "203.0.113.5:41641:vni:1", LatencySeconds: .1}, nil},
		{"unknown must not imply direct", "unknown", &ipnstate.PingResult{LatencySeconds: .03}, nil},
		{"timeout", "unreachable", nil, context.DeadlineExceeded},
		{"ping error payload", "unreachable", &ipnstate.PingResult{Err: "peer unavailable"}, nil},
		{"nil response", "unreachable", nil, nil},
		{"self is not a remote peer", "unreachable", &ipnstate.PingResult{IsLocalIP: true}, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeDiagnosticClient{result: test.result, err: test.err}
			probe, err := probePeer(context.Background(), client, "100.90.1.2")
			if err != nil || probe.Path != test.path || client.calls != 1 || probe.PeerAddress != "100.90.1.2" {
				t.Fatalf("unexpected probe: %+v, %v", probe, err)
			}
			if probe.Path == "unreachable" && probe.LatencyMs != nil {
				t.Fatal("unreachable peer must not report zero latency")
			}
			if probe.Path == "direct" && (probe.Endpoint != test.result.Endpoint || probe.LatencyMs == nil || *probe.LatencyMs != 21.25) {
				t.Fatal("direct endpoint or latency was lost", probe)
			}
			if probe.Path == "derp" && (probe.DERPRegionID != 17 || probe.DERPRegionCode != "lax" || probe.DERPRegionName != "Los Angeles") {
				t.Fatal("missing actual relay region", probe)
			}
		})
	}
}

func TestDiagnosticsRejectNonTailnetDestinationsBeforeProbing(t *testing.T) {
	client := &fakeDiagnosticClient{}
	for _, address := range []string{"", "127.0.0.1", "192.168.1.2", "203.0.113.4", "example.com", "100.90.1.2:41641", "::1"} {
		if _, err := probePeer(context.Background(), client, address); err == nil {
			t.Fatal("accepted non-Tailnet destination", address)
		}
	}
	if client.calls != 0 {
		t.Fatal("probed an invalid destination")
	}
}
