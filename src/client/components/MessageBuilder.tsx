import React, { useState } from 'react';

interface Message {
  role: string;
  content: string;
}

interface MessageBuilderProps {
  messages: Message[];
  isEditable: boolean;
  onChange: (messages: Message[]) => void;
}

function MessageBuilder({ messages, isEditable, onChange }: MessageBuilderProps) {
  const [localMessages, setLocalMessages] = useState<Message[]>(messages);

  const handleMessageChange = (index: number, field: 'role' | 'content', value: string) => {
    const updated = [...localMessages];
    updated[index] = { ...updated[index], [field]: value };
    setLocalMessages(updated);
    onChange(updated);
  };

  const handleAddMessage = () => {
    const updated = [...localMessages, { role: 'user', content: '' }];
    setLocalMessages(updated);
    onChange(updated);
  };

  const handleDeleteMessage = (index: number) => {
    const updated = localMessages.filter((_, i) => i !== index);
    setLocalMessages(updated);
    onChange(updated);
  };

  if (!isEditable) {
    return (
      <div className="message-builder read-only">
        <label>Messages</label>
        <pre className="value-display">{JSON.stringify(messages, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div className="message-builder">
      <div className="message-header">
        <label>Messages</label>
        <button onClick={handleAddMessage} className="add-button">+ Add Message</button>
      </div>

      {localMessages.map((message, index) => (
        <div key={index} className="message-item">
          <div className="message-controls">
            <select
              value={message.role}
              onChange={(e) => handleMessageChange(index, 'role', e.target.value)}
            >
              <option value="system">system</option>
              <option value="user">user</option>
              <option value="assistant">assistant</option>
              <option value="tool">tool</option>
            </select>

            <button
              onClick={() => handleDeleteMessage(index)}
              className="delete-button"
            >
              Delete
            </button>
          </div>

          <textarea
            value={message.content}
            onChange={(e) => handleMessageChange(index, 'content', e.target.value)}
            placeholder="Message content..."
            rows={3}
          />
        </div>
      ))}

      {localMessages.length === 0 && (
        <div className="empty-messages">
          No messages. Click "Add Message" to create one.
        </div>
      )}
    </div>
  );
}

export default MessageBuilder;
