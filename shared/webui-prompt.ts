import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';

export function addWebUIPrompt(event: BeforeAgentStartEvent): void {
  event.systemPromptOptions.sections.pi_webui =
    'Pi Web UI renders Markdown code blocks tagged `mermaid` as diagrams. To display a diagram, use a standalone `mermaid` code block rather than nesting it inside another code block. The renderer is Pele, which may differ from Mermaid. Image nodes support HTTP(S) URLs.';
}
