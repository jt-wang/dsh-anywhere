package main

import (
	"context"
	"errors"
	"testing"

	"tailscale.com/tailcfg"
)

func TestAfterMap(t *testing.T) {
	dm := &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{900: {RegionID: 900}, 901: {RegionID: 901}}}
	ok := func(context.Context) (*tailcfg.DERPRegion, error) { return dm.Regions[901], nil }
	bad := func(context.Context) (*tailcfg.DERPRegion, error) { return nil, errNoRegions }
	for _, c := range []struct {
		name   string
		pick   func(context.Context, *tailcfg.DERPMap) (tailcfg.DERPRegionID, error)
		expand func(context.Context) (*tailcfg.DERPRegion, error)
		want   int
	}{
		// A non-empty map whose netcheck measured nothing: Expand still picks a region, so the helper runs.
		{"no region measured, helper picks one", func(context.Context, *tailcfg.DERPMap) (tailcfg.DERPRegionID, error) { return 0, nil }, ok, 0},
		{"measured", func(context.Context, *tailcfg.DERPMap) (tailcfg.DERPRegionID, error) { return 900, nil }, ok, 0},
		{"netcheck error", func(context.Context, *tailcfg.DERPMap) (tailcfg.DERPRegionID, error) { return 0, errors.New("x") }, ok, 2},
		{"helper pick fails", func(context.Context, *tailcfg.DERPMap) (tailcfg.DERPRegionID, error) { return 0, nil }, bad, 3},
	} {
		pickBestRegion, expandRegion = c.pick, c.expand
		if got, _ := afterMap(context.Background(), dm); got != c.want {
			t.Errorf("%s: exit %d, want %d", c.name, got, c.want)
		}
	}
}
