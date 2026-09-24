package main

import (
	"context"
	"encoding/json"
	"flag"
	assets "github.com/WangZhuo2015/growdesk-server"
	"github.com/WangZhuo2015/growdesk-server/internal/backend"
	"log/slog"
	"os"
	"time"
)

var revision = "development"

func main() {
	version := flag.Bool("version", false, "print build identity without connecting to services")
	flag.Parse()
	if *version {
		if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"revision": revision, "reference": assets.ReferenceCommit}); err != nil {
			os.Exit(1)
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := backend.ApplyNativeMigrations(ctx); err != nil {
		slog.Error("native migrations failed", "error", err)
		os.Exit(1)
	}
	slog.Info("native migrations applied and checksums verified")
}
