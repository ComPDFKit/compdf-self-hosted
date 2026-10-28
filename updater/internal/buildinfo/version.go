package buildinfo

// These values are overridden by release builds with -ldflags.
var (
	Version = "1.1.0"
	Commit  = "unknown"
	BuiltAt = "unknown"
)

type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	BuiltAt string `json:"builtAt"`
}

func Current() Info {
	return Info{Version: Version, Commit: Commit, BuiltAt: BuiltAt}
}
