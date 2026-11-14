package updater

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var reSemver = regexp.MustCompile(`v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?`)

// Semver represents a parsed semantic version (Major.Minor.Patch[-Prerelease]).
type Semver struct {
	Major      int
	Minor      int
	Patch      int
	Prerelease string
}

func (v Semver) String() string {
	base := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if v.Prerelease != "" {
		return base + "-" + v.Prerelease
	}
	return base
}

// ParseSemver extracts the first Major.Minor.Patch[-Prerelease] token from raw.
func ParseSemver(raw string) (Semver, bool) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.EqualFold(s, "dev") {
		return Semver{}, false
	}
	m := reSemver.FindStringSubmatch(s)
	if len(m) < 4 {
		return Semver{}, false
	}
	maj, err1 := strconv.Atoi(m[1])
	min, err2 := strconv.Atoi(m[2])
	pat, err3 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil {
		return Semver{}, false
	}
	var pre string
	if len(m) >= 5 {
		pre = m[4]
	}
	return Semver{
		Major:      maj,
		Minor:      min,
		Patch:      pat,
		Prerelease: pre,
	}, true
}

// IsStable reports whether raw parses as a semantic version without a prerelease suffix.
func IsStable(raw string) bool {
	v, ok := ParseSemver(raw)
	return ok && v.Prerelease == ""
}

// CompareSemver compares two version strings according to SemVer 2.0 precedence.
// It returns (-1, true) if a < b, (0, true) if a == b, (1, true) if a > b,
// or (0, false) when either input does not contain a valid semantic version.
func CompareSemver(a, b string) (int, bool) {
	va, okA := ParseSemver(a)
	vb, okB := ParseSemver(b)
	if !okA || !okB {
		return 0, false
	}
	if va.Major != vb.Major {
		return cmpInt(va.Major, vb.Major), true
	}
	if va.Minor != vb.Minor {
		return cmpInt(va.Minor, vb.Minor), true
	}
	if va.Patch != vb.Patch {
		return cmpInt(va.Patch, vb.Patch), true
	}
	return cmpPrerelease(va.Prerelease, vb.Prerelease), true
}

func cmpInt(a, b int) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func cmpPrerelease(a, b string) int {
	switch {
	case a == "" && b == "":
		return 0
	case a == "":
		// A normal version has higher precedence than a pre-release version.
		return 1
	case b == "":
		return -1
	}
	pa := strings.Split(a, ".")
	pb := strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		if pa[i] == pb[i] {
			continue
		}
		na, errA := strconv.Atoi(pa[i])
		nb, errB := strconv.Atoi(pb[i])
		switch {
		case errA == nil && errB == nil:
			return cmpInt(na, nb)
		case errA == nil:
			// Numeric identifiers have lower precedence than non-numeric identifiers.
			return -1
		case errB == nil:
			return 1
		default:
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return cmpInt(len(pa), len(pb))
}
