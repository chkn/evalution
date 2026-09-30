// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

export type SettingsSection = "appearance" | "load-save";

function AppearanceIcon() {
  return (
    <svg
      className="tree-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function LoadSaveIcon() {
  return (
    <svg
      className="tree-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: () => React.JSX.Element;
}[] = [
  { id: "appearance", label: "Appearance", icon: AppearanceIcon },
  { id: "load-save", label: "Load/Save", icon: LoadSaveIcon },
];

export const settingsSectionLabel = (section: SettingsSection): string =>
  SETTINGS_SECTIONS.find(s => s.id === section)!.label;

interface Props {
  selectedSection: SettingsSection | null;
  onSelect: (section: SettingsSection) => void;
}

/** The sidebar list shown while the Settings icon is active — one row per section. */
function SettingsList({ selectedSection, onSelect }: Props) {
  return (
    <>
      <div className="section-panel-header">
        <span>Settings</span>
      </div>
      <div className="section-panel-body">
        {SETTINGS_SECTIONS.map(section => (
          <div
            key={section.id}
            className={
              "tree-row" +
              (section.id === selectedSection ? " tree-row-selected" : "")
            }
            style={{ paddingLeft: 10 }}
            onClick={() => onSelect(section.id)}
          >
            <span className="tree-icon-file">
              <section.icon />
            </span>
            <span className="tree-row-label">{section.label}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export default SettingsList;
