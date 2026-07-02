export enum Visibility {
  visible = 'visible',
  hidden = 'hidden',
  leanback = 'leanback',
}

export async function setVisibilityAsync(_visibility: Visibility): Promise<void> {}
export async function setBackgroundColorAsync(_color: string): Promise<void> {}
export async function setButtonStyleAsync(_style: 'light' | 'dark'): Promise<void> {}
