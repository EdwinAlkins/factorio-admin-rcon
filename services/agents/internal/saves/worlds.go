package saves

import (
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

// ImportWorld archives a world of the world agent's library, so that putting
// it in play is an ordinary restore — with its checks, its safety copy and
// its rollback. The copy is verified as a save, and against the checksum the
// world agent recorded when the game wrote it.
func (s *Store) ImportWorld(library *worlds.Store, id, createdBy string) (Meta, error) {
	world, err := library.Get(id)
	if err != nil {
		return Meta{}, err
	}
	archiveID, err := s.newID(SourceWorld)
	if err != nil {
		return Meta{}, err
	}
	copied, err := files.CopyAtomic(library.Root(), world.ID+".zip", s.backups, archiveID+".zip", 0o640, VerifySave)
	if err != nil {
		return Meta{}, err
	}
	if copied.SHA256 != world.SHA256 {
		_ = s.backups.Remove(archiveID + ".zip")
		return Meta{}, ErrChecksum
	}

	// The set the game loaded when it generated the world: what a restore
	// compares with the server's.
	modSet := make([]mods.Mod, 0, len(world.Mods))
	for _, mod := range world.Mods {
		modSet = append(modSet, mods.Mod{Name: mod.Name, Version: mod.Version, Enabled: true, Builtin: mod.Version == ""})
	}
	meta := Meta{
		ID:              archiveID,
		Source:          SourceWorld,
		Label:           world.Name,
		CreatedAt:       s.now().UTC(),
		CreatedBy:       createdBy,
		Size:            copied.Size,
		SHA256:          copied.SHA256,
		SaveName:        worlds.SaveName(world),
		FactorioVersion: world.FactorioVersion,
		Mods:            modSet,
	}
	if err := s.writeMeta(meta); err != nil {
		_ = s.backups.Remove(archiveID + ".zip")
		return Meta{}, err
	}
	return meta, nil
}
