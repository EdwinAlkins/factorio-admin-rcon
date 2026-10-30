package factorio

import (
	"encoding/json/v2"
	"strings"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

// mergeMapSettings lays a world's map settings over the game's own: the game
// refuses a map-settings.json with any member missing, so the file it gets
// is always the complete one with the operator's values replaced.
func mergeMapSettings(base map[string]any, overlay *worlds.MapSettings) ([]byte, error) {
	raw, err := json.Marshal(overlay)
	if err != nil {
		return nil, err
	}
	var changes map[string]any
	if err := json.Unmarshal(raw, &changes); err != nil {
		return nil, err
	}
	return json.Marshal(merge(clone(base), changes))
}

// merge copies `changes` into `into`, recursing into objects.
func merge(into, changes map[string]any) map[string]any {
	for key, value := range changes {
		nested, isObject := value.(map[string]any)
		existing, hasObject := into[key].(map[string]any)
		if isObject && hasObject {
			into[key] = merge(existing, nested)
		} else {
			into[key] = value
		}
	}
	return into
}

func clone(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for key, value := range m {
		if nested, ok := value.(map[string]any); ok {
			value = clone(nested)
		}
		out[key] = value
	}
	return out
}

// dropComments removes the `_comment…` members of the game's example file.
func dropComments(m map[string]any) {
	for key, value := range m {
		if strings.HasPrefix(key, "_comment") {
			delete(m, key)
			continue
		}
		if nested, ok := value.(map[string]any); ok {
			dropComments(nested)
		}
	}
}
