// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { autosave } from "../autosave";
import { usePersistentValue } from "../hooks/usePersistentValue";
import { type ThemeSetting, themeSetting } from "../theme";
import { type SettingsSection, settingsSectionLabel } from "./SettingsList";

const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function AppearanceSettings() {
  const [theme, setTheme] = usePersistentValue(themeSetting);
  return (
    <div className="settings-row">
      <span className="settings-row-label">Theme</span>
      <div className="settings-segmented" role="radiogroup" aria-label="Theme">
        {THEME_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={theme === opt.value}
            className={
              "settings-segmented-btn" +
              (theme === opt.value ? " is-active" : "")
            }
            onClick={() => setTheme(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function LoadSaveSettings() {
  const [autosaveEnabled, setAutosaveEnabled] = usePersistentValue(autosave);
  return (
    <label className="settings-row settings-checkbox-row">
      <input
        type="checkbox"
        checked={autosaveEnabled}
        onChange={e => setAutosaveEnabled(e.target.checked)}
      />
      <span className="settings-row-label">Autosave</span>
      <span className="settings-row-hint">
        Save unsaved edits to the file automatically once they settle.
      </span>
    </label>
  );
}

interface Props {
  section: SettingsSection;
}

/** The tab content for a settings section — the ref bar's Autosave checkbox now lives here, under Load/Save. */
function SettingsView({ section }: Props) {
  return (
    <div className="settings-view">
      <h2 className="settings-view-title">{settingsSectionLabel(section)}</h2>
      {section === "appearance" ? <AppearanceSettings /> : <LoadSaveSettings />}
    </div>
  );
}

export default SettingsView;
