import type { ImageDimensions } from '../components/cell/model';

const fallbackAspect = 16 / 9;
const portraitHeightLimit = 600;

export function articleImageAspect(size?: ImageDimensions) {
  return size && size.width > 0 && size.height > 0 ? size.width / size.height : fallbackAspect;
}

export function articleImageStripRows(
  availableWidth: number,
  cellHeight: number,
  gap: number,
  sizes: readonly (ImageDimensions | undefined)[],
) {
  const aspects = sizes.map(articleImageAspect);
  const widest = Math.max(0, ...aspects);
  const [first, second] = aspects;
  const height = first && second && widest < 1
    ? Math.min((availableWidth - gap) / (first + second), availableWidth * 1.25, availableWidth / widest, portraitHeightLimit)
    : Math.min(360, availableWidth * 0.72 / Math.max(1, widest));
  return Math.max(1, Math.floor(height / cellHeight));
}

export function articleImageStripWidth(availableWidth: number, height: number, size?: ImageDimensions) {
  return Math.min(availableWidth, height * articleImageAspect(size));
}
