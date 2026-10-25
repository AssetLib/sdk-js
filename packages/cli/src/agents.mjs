// The section adopt and init keep in the app's AGENTS.md (and CLAUDE.md when it does not import AGENTS.md), so coding
// agents use placements instead of exporting their art: from the catalog, and from the Assetlib Figma plugin's marker.
export const AGENTS_START = '<!-- assetlib:start -->';
export const AGENTS_END = '<!-- assetlib:end -->';

const plain = value => String(value).replace(/[`\r\n]/g, '');

export function agentSection({ catalogFile, generatedFile, example }) {
  const catalog = `\`${plain(catalogFile)}\``, generated = `\`${plain(generatedFile)}\``;
  const reference = example ? `, for example \`asset={AppAssets.${example.symbol.join('.')}}\` for \`${example.key}\`` : '';
  return [
    AGENTS_START,
    '## Artwork that changes after release (Assetlib)',
    '',
    `\`assetlib adopt\` keeps this section up to date; edit outside its markers. Images declared in ${catalog} are Assetlib placements: they can change after the app is released, and the bundled image is the fallback.`,
    '',
    `- Read ${catalog} before adding or changing artwork.`,
    `- Render a placement with \`AssetlibImage\` from \`@assetlib/sdk-expo\` and its generated reference${reference}, with the bundled image as \`fallback\`. When a screen draws artwork through the app's own image component, keep that component and wrap the call site in \`AssetlibPlacement\`, which hands it \`placement.source\`. Never point an \`Image\` at a placement's file instead.`,
    '- In Figma, art inserted by the Assetlib plugin is a component whose description starts with "Assetlib placement" and the key, and whose layer name starts with the key. When you build a screen from Figma, including with Figma\'s design-to-code skill, treat that art as data-supplied imagery whose exact codebase match is the key\'s generated reference, and render it with that reference. Download the image only when the key isn\'t in the catalog yet, as its bundled fallback, and use Figma\'s image as it is rather than redrawing it.',
    `- To add art that should change after release, add a catalog entry and its bundled fallback image in the same change, then regenerate ${generated} with \`assetlib-codegen\` (\`assetlib adopt\` does both for an existing image call site). CI's \`assetlib sync\` declares it. Never create placements in the Assetlib console.`,
    `- Never edit ${generated} by hand; \`assetlib check\` compares it. Renaming a key creates a new placement, so ask first.`,
    '- Not placements: the app icon, the splash screen, colors, and images that come from user or API data.',
    '- To see what a placement shows in draft, staging and production, where it is used in code, and its release history, use the Assetlib MCP server (add it with `claude mcp add --transport http assetlib https://console.assetlib.dev/mcp`). Through it you may upload images and assign them to placements as a draft.',
    '- Agents never publish, never create placements or tokens in the console, and never put a token in code or chat.',
    AGENTS_END,
  ].join('\n') + '\n';
}

/** The file with the section added or replaced, or null when its markers are missing a pair, repeated, or out of order. */
export function withAgentSection(existing, section) {
  if (existing === null) return section;
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const text = newline === '\n' ? section : section.replace(/\n/g, '\r\n');
  const start = existing.indexOf(AGENTS_START), end = existing.indexOf(AGENTS_END);
  const repeated = existing.indexOf(AGENTS_START, start + 1) >= 0 || existing.indexOf(AGENTS_END, end + 1) >= 0;
  if (start < 0 && end < 0) return existing + (existing === '' || existing.endsWith(newline) ? '' : newline) + (existing === '' ? '' : newline) + text;
  if (start < 0 || end < start || repeated) return null;
  const after = end + AGENTS_END.length;
  return existing.slice(0, start) + text + existing.slice(existing.startsWith(newline, after) ? after + newline.length : after);
}

/** True when CLAUDE.md imports AGENTS.md (`@AGENTS.md`), so Claude Code already reads the section there. */
export function importsAgents(claude) {
  return /(^|\s)@(\.\/)?AGENTS\.md\b/m.test(claude);
}
