//go:build windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
)

// checkDirWritable verifies that dir exists and is not marked read-only on Windows.
func checkDirWritable(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s 不是目录", dir)
	}
	if info.Mode().Perm()&0o200 == 0 {
		return fmt.Errorf("目录 %s 为只读状态", dir)
	}
	return nil
}

// ExecSelf spawns a replacement process on Windows and returns so the caller can exit cleanly.
func ExecSelf(exePath string, argv []string, envv []string) error {
	var args []string
	if len(argv) > 1 {
		args = argv[1:]
	}
	cmd := exec.Command(exePath, args...)
	cmd.Env = envv
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Start()
}
