package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	assets "github.com/WangZhuo2015/growdesk-server"
	"github.com/WangZhuo2015/growdesk-server/internal/backend"
)

var revision="development"
func main(){
	inventory:=flag.Bool("contract-inventory",false,"print declared/native coverage, not an acceptance verdict")
	version:=flag.Bool("version",false,"print build and reference revisions")
	flag.Parse()
	if *version{_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"revision":revision,"reference":assets.ReferenceCommit});return}
	if *inventory{
		contract,err:=backend.LoadContract();if err!=nil{slog.Error("contract load failed","error",err);os.Exit(1)}
		s:=&backend.Server{Contract:contract,Handlers:map[string]backend.Handler{},Public:map[string]bool{}}
		s.RegisterBusinessHandlers()
		rows:=make([]map[string]any,0,len(contract.Routes));for _,r:=range contract.Routes{implemented:=s.Handlers[r.OperationID]!=nil||r.OperationID=="getHealthLive"||r.OperationID=="getHealthReady";rows=append(rows,map[string]any{"method":r.Method,"path":r.Path,"operationId":r.OperationID,"implemented":implemented,"verified":false})};_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"reference":assets.ReferenceCommit,"acceptance":"IMPLEMENTED_NOT_REVIEWED","operations":rows});return
	}
	log:=slog.New(slog.NewJSONHandler(os.Stdout,nil));slog.SetDefault(log)
	config,err:=backend.LoadConfig();if err!=nil{log.Error("configuration rejected","error",err);os.Exit(1)}
	ctx,stop:=signal.NotifyContext(context.Background(),syscall.SIGINT,syscall.SIGTERM);defer stop()
	startup,cancel:=context.WithTimeout(ctx,10*time.Second);app,err:=backend.NewServer(startup,config,log);cancel();if err!=nil{log.Error("startup failed","error",err);os.Exit(1)}
	defer app.Close();app.RegisterBusinessHandlers()
	server:=&http.Server{Addr:config.Address,Handler:app,ReadHeaderTimeout:5*time.Second,ReadTimeout:30*time.Second,IdleTimeout:60*time.Second,MaxHeaderBytes:32768}
	done:=make(chan error,1);go func(){done<-server.ListenAndServe()}()
	log.Info("native Go API listening","address",config.Address,"revision",revision,"reference",assets.ReferenceCommit)
	select{case err:=<-done:if !errors.Is(err,http.ErrServerClosed){log.Error("HTTP server failed","error",err);return};case <-ctx.Done():shutdown,release:=context.WithTimeout(context.Background(),20*time.Second);defer release();if err:=server.Shutdown(shutdown);err!=nil{_ = server.Close();log.Warn("HTTP shutdown deadline reached")}}
}
