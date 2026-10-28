import { h, type Component } from 'vue';

const vectors = import.meta.glob<Component>('@/assets/icons/*.svg', { eager: true, query: '?component', import: 'default' });
const images = import.meta.glob<string>('@/assets/icons/*.png', { eager: true, import: 'default' });

/** Exported Figma artwork, shared by the catalog and detail heading. */
export function toolIcon(name: string): Component | undefined {
  const vector = vectors[`/src/assets/icons/${name}.svg`];
  if (vector) return vector;
  const src = images[`/src/assets/icons/${name}.png`];
  return src ? { render: () => h('img', { src, alt: '' }) } : undefined;
}
