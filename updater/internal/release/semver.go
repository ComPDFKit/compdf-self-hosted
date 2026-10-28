package release

import (
	"fmt"
	"strconv"
	"strings"
)

type semanticVersion struct {
	major      uint64
	minor      uint64
	patch      uint64
	prerelease []string
}

func parseSemanticVersion(value string) (semanticVersion, error) {
	buildParts := strings.Split(value, "+")
	if len(buildParts) > 2 || (len(buildParts) == 2 && !validIdentifiers(buildParts[1])) {
		return semanticVersion{}, fmt.Errorf("version %q has invalid build metadata", value)
	}
	withoutBuild := buildParts[0]
	parts := strings.SplitN(withoutBuild, "-", 2)
	core := strings.Split(parts[0], ".")
	if len(core) != 3 {
		return semanticVersion{}, fmt.Errorf("version %q must contain major.minor.patch", value)
	}
	numbers := make([]uint64, 3)
	for index, item := range core {
		if item == "" || (len(item) > 1 && item[0] == '0') {
			return semanticVersion{}, fmt.Errorf("version %q has an invalid numeric component", value)
		}
		number, err := strconv.ParseUint(item, 10, 64)
		if err != nil {
			return semanticVersion{}, fmt.Errorf("version %q has an invalid numeric component", value)
		}
		numbers[index] = number
	}

	var prerelease []string
	if len(parts) == 2 {
		if parts[1] == "" {
			return semanticVersion{}, fmt.Errorf("version %q has an empty prerelease", value)
		}
		prerelease = strings.Split(parts[1], ".")
		for _, identifier := range prerelease {
			if !validPrereleaseIdentifier(identifier) {
				return semanticVersion{}, fmt.Errorf("version %q has an invalid prerelease", value)
			}
		}
	}

	return semanticVersion{
		major:      numbers[0],
		minor:      numbers[1],
		patch:      numbers[2],
		prerelease: prerelease,
	}, nil
}

func validIdentifiers(value string) bool {
	if value == "" {
		return false
	}
	for _, identifier := range strings.Split(value, ".") {
		if identifier == "" {
			return false
		}
		for _, char := range identifier {
			if (char < '0' || char > '9') && (char < 'A' || char > 'Z') && (char < 'a' || char > 'z') && char != '-' {
				return false
			}
		}
	}
	return true
}

// CompareVersions returns -1, 0, or 1 when left is lower than, equal to, or
// greater than right.
func CompareVersions(left, right string) (int, error) {
	leftVersion, err := parseSemanticVersion(left)
	if err != nil {
		return 0, err
	}
	rightVersion, err := parseSemanticVersion(right)
	if err != nil {
		return 0, err
	}
	return compareSemanticVersions(leftVersion, rightVersion), nil
}

func validPrereleaseIdentifier(value string) bool {
	if value == "" {
		return false
	}
	numeric := true
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'A' || char > 'Z') && (char < 'a' || char > 'z') && char != '-' {
			return false
		}
		if char < '0' || char > '9' {
			numeric = false
		}
	}
	return !numeric || len(value) == 1 || value[0] != '0'
}

func compareSemanticVersions(left, right semanticVersion) int {
	for _, pair := range [][2]uint64{{left.major, right.major}, {left.minor, right.minor}, {left.patch, right.patch}} {
		if pair[0] < pair[1] {
			return -1
		}
		if pair[0] > pair[1] {
			return 1
		}
	}
	if len(left.prerelease) == 0 && len(right.prerelease) == 0 {
		return 0
	}
	if len(left.prerelease) == 0 {
		return 1
	}
	if len(right.prerelease) == 0 {
		return -1
	}

	limit := len(left.prerelease)
	if len(right.prerelease) < limit {
		limit = len(right.prerelease)
	}
	for index := 0; index < limit; index++ {
		comparison := comparePrereleaseIdentifier(left.prerelease[index], right.prerelease[index])
		if comparison != 0 {
			return comparison
		}
	}
	if len(left.prerelease) < len(right.prerelease) {
		return -1
	}
	if len(left.prerelease) > len(right.prerelease) {
		return 1
	}
	return 0
}

func comparePrereleaseIdentifier(left, right string) int {
	leftNumber, leftNumeric := numericIdentifier(left)
	rightNumber, rightNumeric := numericIdentifier(right)
	if leftNumeric && rightNumeric {
		if leftNumber < rightNumber {
			return -1
		}
		if leftNumber > rightNumber {
			return 1
		}
		return 0
	}
	if leftNumeric {
		return -1
	}
	if rightNumeric {
		return 1
	}
	return strings.Compare(left, right)
}

func numericIdentifier(value string) (uint64, bool) {
	number, err := strconv.ParseUint(value, 10, 64)
	return number, err == nil
}
