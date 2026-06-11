// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { JSX } from "react";
import anthropicIcon from "../assets/providers/anthropic.svg?raw";
import googleIcon from "../assets/providers/google.svg?raw";
import openAIIcon from "../assets/providers/openai.svg?raw";
import vercelIcon from "../assets/providers/vercel.svg?raw";

function RawProviderIcon({ icon, size }: { icon: string; size: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        width: size,
        height: size,
        fontSize: size,
      }}
      dangerouslySetInnerHTML={{ __html: icon }}
    />
  );
}

function FallbackIcon({ provider, size }: { provider?: string; size: number }) {
  const letter = provider?.charAt(0).toUpperCase() ?? "";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill="#888" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fill="white"
        fontSize="13"
        fontWeight="600"
        fontFamily="system-ui, sans-serif"
      >
        {letter}
      </text>
    </svg>
  );
}

const ICON_COMPONENTS: Record<
  string,
  (props: { size: number }) => JSX.Element
> = {
  OpenAI: ({ size }) => <RawProviderIcon icon={openAIIcon} size={size} />,
  Anthropic: ({ size }) => <RawProviderIcon icon={anthropicIcon} size={size} />,
  Google: ({ size }) => <RawProviderIcon icon={googleIcon} size={size} />,
  vercel: ({ size }) => <RawProviderIcon icon={vercelIcon} size={size} />,
};

export default function ProviderIcon({
  provider,
  size = 24,
}: {
  provider?: string;
  size?: number;
}) {
  const Icon = provider ? ICON_COMPONENTS[provider] : undefined;
  if (Icon) return <Icon size={size} />;
  return <FallbackIcon provider={provider} size={size} />;
}
