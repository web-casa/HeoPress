import { createContext } from 'react';

/** Rich-text fields inside the article editor's body take its look (no frame, larger type). */
export const RichTextVariant = createContext<'article' | 'field'>('field');
