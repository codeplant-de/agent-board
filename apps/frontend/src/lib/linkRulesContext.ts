import type { LinkRule } from '@agent-board/shared';
import { createContext, useContext } from 'react';

const NO_RULES: readonly LinkRule[] = [];

/** The user's link rules, which `Markdown` applies. None outside the provider and while they load or cannot be read. */
export const LinkRulesContext = createContext<readonly LinkRule[]>(NO_RULES);

export const useLinkRules = (): readonly LinkRule[] => useContext(LinkRulesContext);
