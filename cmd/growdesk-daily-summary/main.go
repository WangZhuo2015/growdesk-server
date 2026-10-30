package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	assets "github.com/WangZhuo2015/growdesk-server"
	"github.com/WangZhuo2015/growdesk-server/internal/backend"
)

var revision = "development"

func main() {
	worker := flag.Bool("worker", false, "run the daily-only worker (default)")
	scheduler := flag.Bool("scheduler", false, "enqueue due summaries; requires --once (alias for bare --once)")
	once := flag.Bool("once", false, "enqueue due summaries once; with --worker, process one daily job")
	version := flag.Bool("version", false, "print the source revision")
	flag.Parse()
	if *version {
		if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"revision": revision, "reference": assets.ReferenceCommit}); err != nil {
			os.Exit(1)
		}
		return
	}
	if *worker && *scheduler {
		slog.Error("choose only one daily summary mode")
		os.Exit(2)
	}
	mode := "worker"
	if *scheduler || (*once && !*worker) {
		mode = "scheduler"
	}
	if mode == "scheduler" && !*once {
		slog.Error("daily summary scheduler requires --once")
		os.Exit(2)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	kind := "daily-summary-worker"
	if mode == "scheduler" {
		kind = "daily-summary-scheduler"
	}
	if err := backend.RunNativeRuntime(ctx, kind, *once, log); err != nil {
		log.Error("daily summary process stopped", "error", err)
		os.Exit(1)
	}
}
