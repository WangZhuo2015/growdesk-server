//go:build linux || darwin

package backend

import (
	"syscall"
)

func syscallKillProcess(pid int) error {
	err := syscall.Kill(pid, 0)
	if err == syscall.ESRCH {
		return syscall.ESRCH
	}
	return err
}
