//go:build !linux && !darwin

package backend

import "os/exec"

func configureLocalASRProcessGroup(*exec.Cmd) {}
