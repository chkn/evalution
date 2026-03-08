import { useState, useEffect } from 'react';
import type { PromptProviderInfo, AddPromptContext, ParsedPrompt } from '../../shared/types';
import { getPromptProviders, addPrompt } from '../api';

interface AddPromptDialogProps {
  onClose: () => void;
  onCreated: (prompt: ParsedPrompt) => void;
}

type Step =
  | { type: 'loading' }
  | { type: 'pick-provider'; providers: PromptProviderInfo[] }
  | { type: 'form'; providerId: string; context: AddPromptContext }
  | { type: 'submitting' };

function AddPromptDialog({ onClose, onCreated }: AddPromptDialogProps) {
  const [step, setStep] = useState<Step>({ type: 'loading' });
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPromptProviders().then(providers => {
      const addable = providers.filter(p => p.hasAddPrompt);
      if (addable.length === 0) {
        setError('No providers support adding prompts');
      } else if (addable.length === 1) {
        // Skip provider picker — go straight to form
        fetchContext(addable[0].id);
      } else {
        setStep({ type: 'pick-provider', providers: addable });
      }
    }).catch(e => setError(e.message));
  }, []);

  async function fetchContext(providerId: string) {
    setStep({ type: 'loading' });
    setError(null);
    try {
      const result = await addPrompt(providerId, {});
      if ('fields' in result) {
        const defaults: Record<string, string> = {};
        for (const f of result.fields) {
          if (f.defaultValue) defaults[f.name] = f.defaultValue;
        }
        setFieldValues(defaults);
        setStep({ type: 'form', providerId, context: result });
      } else {
        // Provider created the prompt immediately
        onCreated(result as ParsedPrompt);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step.type !== 'form') return;

    setError(null);
    setStep({ type: 'submitting' });

    // Build partial from field values
    const partial: Record<string, any> = {};
    for (const [key, value] of Object.entries(fieldValues)) {
      if (!value) continue;
      partial[key] = value;
    }

    // Handle the special directory + fileName combo for file providers
    if (partial.directory !== undefined && partial.fileName) {
      const dir = partial.directory === '.' ? '' : partial.directory + '/';
      partial.metadata = { relativeFilePath: dir + partial.fileName };
      delete partial.directory;
      delete partial.fileName;
    }

    try {
      const result = await addPrompt(step.providerId, partial);
      if ('fields' in result) {
        // Provider still needs more info
        const defaults: Record<string, string> = {};
        for (const f of result.fields) {
          if (f.defaultValue) defaults[f.name] = f.defaultValue;
        }
        setFieldValues({ ...defaults, ...fieldValues });
        setStep({ type: 'form', providerId: step.providerId, context: result });
      } else {
        onCreated(result as ParsedPrompt);
      }
    } catch (e: any) {
      setError(e.message);
      setStep({ type: 'form', providerId: step.providerId, context: step.context });
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>New Prompt</h3>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>

        <div className="dialog-body">
          {error && <div className="dialog-error">{error}</div>}

          {step.type === 'loading' && <div className="dialog-status">Loading...</div>}

          {step.type === 'submitting' && <div className="dialog-status">Creating...</div>}

          {step.type === 'pick-provider' && (
            <div className="dialog-providers">
              {step.providers.map(p => (
                <button
                  key={p.id}
                  className="dialog-provider-btn"
                  onClick={() => fetchContext(p.id)}
                >
                  {p.icon && (
                    <span
                      className="dialog-provider-icon"
                      dangerouslySetInnerHTML={{ __html: p.icon }}
                    />
                  )}
                  <div>
                    <div className="dialog-provider-name">{p.displayName ?? p.id}</div>
                    {p.description && (
                      <div className="dialog-provider-desc">{p.description}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {step.type === 'form' && (
            <form onSubmit={handleSubmit}>
              {step.context.fields.map(field => (
                <div key={field.name} className="dialog-field">
                  <label>{field.label}</label>
                  {field.type === 'select' ? (
                    <select
                      value={fieldValues[field.name] ?? ''}
                      onChange={e => setFieldValues(v => ({ ...v, [field.name]: e.target.value }))}
                      required={field.required}
                    >
                      {field.options?.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={fieldValues[field.name] ?? ''}
                      onChange={e => setFieldValues(v => ({ ...v, [field.name]: e.target.value }))}
                      placeholder={field.placeholder}
                      required={field.required}
                    />
                  )}
                </div>
              ))}
              <div className="dialog-actions">
                <button type="button" className="dialog-btn-cancel" onClick={onClose}>Cancel</button>
                <button type="submit" className="dialog-btn-create">Create</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddPromptDialog;
