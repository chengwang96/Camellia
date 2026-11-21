//go:build ts_omit_useproxy

package main

import (
	"testing"

	"tailscale.com/feature"
	"tailscale.com/feature/buildfeatures"
)

func TestSystemProxyFeatureIsOmitted(t *testing.T) {
	if buildfeatures.HasUseProxy || feature.Registered()["useproxy"] {
		t.Fatal("embedded network must not use the desktop's system proxy")
	}
}
