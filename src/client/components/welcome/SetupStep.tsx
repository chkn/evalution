import { useState } from 'react';
import {
  AI_SDK_OPTIONS,
  CONFIG_DOCS_URL,
  CONFIG_FILE_RELATIVE_PATH,
  configFileTemplate,
  type AiSdkChoice,
} from '../../../shared/config-template';
import { createConfigFile } from '../../api';
import { CopyBox } from './CopyBox';

/** Setup instructions URL the coding agent is pointed at. */
const AGENT_SETUP_URL = 'https://evalut.io/n/docs/setup.md';

type FileState =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'created' }
  | { status: 'error'; message: string };

/**
 * Project setup step: offers two paths — hand the work to a coding agent, or
 * set things up manually by choosing an AI SDK and dropping in a config
 * snippet. There is no "next" action; the wizard advances on its own once the
 * config file is detected and loaded by the server.
 */
export function SetupStep() {
  const [sdk, setSdk] = useState<AiSdkChoice>('vercel-ai-sdk');
  const [file, setFile] = useState<FileState>({ status: 'idle' });

  const snippet = configFileTemplate(sdk);

  const handleCreateFile = async () => {
    setFile({ status: 'creating' });
    try {
      const { path } = await createConfigFile(sdk);
      setFile({ status: 'created' });
    } catch (e: any) {
      setFile({ status: 'error', message: e.message });
    }
  };

  return (
    <div className="setup-split">
      {/* ── Top: let a coding agent do it ── */}
      <section className="setup-pane">
        <h3>Set up with a coding agent</h3>
        <p className="welcome-subtitle">
          Paste this prompt into your coding agent and let it wire up Evalution for you:
        </p>
        <CopyBox text={`Follow the guide at ${AGENT_SETUP_URL} to set up Evalution.`}>
          Follow the guide at{' '}
          <a className="welcome-link" href={AGENT_SETUP_URL} target="_blank">
            {AGENT_SETUP_URL}
          </a>
          {' '}to set up Evalution.
        </CopyBox>
      </section>

      <div className="setup-divider"><span>or set up manually</span></div>

      {/* ── Bottom: manual setup ── */}
      <section className="setup-pane">
        <h3>Manual setup</h3>

        <label className="welcome-field">
          <span>Which AI SDK are you using?</span>
          <select value={sdk} onChange={e => setSdk(e.target.value as AiSdkChoice)}>
            {AI_SDK_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>

        <p className="welcome-subtitle">
          Add this to <code>{CONFIG_FILE_RELATIVE_PATH}</code>:
        </p>
        <CopyBox text={snippet} multiline />

        <div className="setup-actions">
          <button
            type="button"
            className="welcome-btn-secondary"
            onClick={handleCreateFile}
            disabled={file.status === 'creating' || file.status === 'created'}
          >
            {file.status === 'creating' || file.status === 'created' ? 'Creating…' : 'Create the file for me'}
          </button>
          <a className="welcome-link" href={CONFIG_DOCS_URL} target="_blank" rel="noreferrer">
            Config docs ↗
          </a>
        </div>
        {file.status === 'error' && (
          <div className={`setup-file-status setup-file-${file.status}`}>{file.message}</div>
        )}
      </section>
    </div>
  );
}
