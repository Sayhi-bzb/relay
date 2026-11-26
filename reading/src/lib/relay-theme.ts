import { CLASSIC_MAC_DARK_THEME, CLASSIC_MAC_LIGHT_THEME } from './cell-ui/theme';
import type { CellMarkdownColors } from './cell-ui/theme';

const dark: CellMarkdownColors = {
  accent: '#61afef', strong: CLASSIC_MAC_DARK_THEME.markdownColors.strong, link: '#61afef', quote: '#98c379', muted: '#919baa',
  codeForeground: '#98c379', codeBackground: '#282c34', codeKey: '#c678dd', codeValue: '#98c379',
  codeCommand: '#61afef', codeComment: '#919baa',
};

const light: CellMarkdownColors = {
  accent: '#295ac2', strong: CLASSIC_MAC_LIGHT_THEME.markdownColors.strong, link: '#295ac2', quote: '#397b39', muted: '#696a70',
  codeForeground: '#00852c', codeBackground: '#f0f0f0', codeKey: '#a626a4', codeValue: '#397b39',
  codeCommand: '#295ac2', codeComment: '#696a70',
};

export const relayThemes = {
  dark: { ...CLASSIC_MAC_DARK_THEME, markdownColors: dark },
  light: { ...CLASSIC_MAC_LIGHT_THEME, markdownColors: light },
};
