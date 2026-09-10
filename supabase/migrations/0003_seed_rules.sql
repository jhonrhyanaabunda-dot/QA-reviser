-- ============================================================
-- QA Reviser — built-in QA rule library
-- Global rules: user_id is null. Users can deactivate a built-in
-- rule for themselves by cloning it; these rows stay read-only.
-- Safe to re-run (upsert on code).
-- ============================================================

insert into public.qa_rules
  (user_id, code, title, description, category, kind, severity, pattern, replacement, guidance, fix_mode, is_builtin, sort_order)
values
-- ---------- AI writing-pattern detection ---------------------
(null, 'AI_EM_DASH_SPAM', 'Em-dash overuse',
 'Three or more em dashes in an article is a strong LLM tell. Human automotive copy rarely stacks them.',
 'ai-pattern', 'regex', 'medium', '—', null,
 'Recast as commas, parentheses, or separate sentences.',
 'suggest', true, 10),

(null, 'AI_NOT_ONLY_BUT', '"Not only... but also" construction',
 'A hallmark LLM sentence frame that reads as padding in dealership copy.',
 'ai-pattern', 'regex', 'medium', '\bnot only\b[^.!?]{0,120}?\bbut also\b', null,
 null, 'suggest', true, 11),

(null, 'AI_DELVE_VOCAB', 'LLM signature vocabulary',
 'Words that appear at wildly elevated rates in generated text: delve, tapestry, testament, realm, navigate the landscape, unlock the potential.',
 'ai-pattern', 'regex', 'medium',
 '\b(delve[sd]?\s+into|a\s+testament\s+to|rich\s+tapestry|in\s+the\s+realm\s+of|navigat(?:e|ing)\s+the\s+(?:landscape|complexities)|unlock(?:ing)?\s+the\s+(?:full\s+)?potential|game[\s-]changer|when\s+it\s+comes\s+to)\b',
 null, null, 'suggest', true, 12),

(null, 'AI_TRIPLE_ADJECTIVE', 'Rule-of-three padding',
 'Stacked adjective/noun triples ("reliable, efficient, and affordable") are an LLM rhythm tic.',
 'ai-pattern', 'ai', 'low', null, null,
 'Flag sentences containing three or more comma-separated adjectives or short noun phrases ending in "and X", where the list adds no concrete information. Suggest cutting to the one or two that carry real meaning.',
 'suggest', true, 13),

(null, 'AI_HEDGE_OPENER', 'Generic hedging opener',
 'Openers like "In today''s fast-paced world" or "Whether you''re a first-time buyer or a seasoned driver" say nothing.',
 'ai-pattern', 'regex', 'medium',
 '(?:in\s+today''s\s+(?:fast[\s-]paced|ever[\s-]changing|digital)\s+world|whether\s+you''re\s+a[^.!?]{0,80}?\bor\b[^.!?]{0,80}?,|in\s+the\s+world\s+of\s+\w+,)',
 null, null, 'suggest', true, 14),

(null, 'AI_CONCLUSION_SCAFFOLD', 'Essay scaffolding phrases',
 '"In conclusion", "Ultimately", "At the end of the day" as paragraph openers signal templated structure.',
 'ai-pattern', 'regex', 'low',
 '(?:^|\n)\s*(?:In\s+conclusion|Ultimately|At\s+the\s+end\s+of\s+the\s+day|In\s+summary|To\s+sum\s+up)\s*,',
 null, null, 'suggest', true, 15),

(null, 'AI_UNIFORM_PARAGRAPHS', 'Mechanically uniform paragraphs',
 'Every paragraph landing within a few words of the same length is a generation artifact, not natural writing.',
 'ai-pattern', 'structural', 'low', null, null,
 'Flagged when 5+ body paragraphs have a standard deviation under 15% of their mean length.',
 'suggest', true, 16),

-- ---------- Accuracy & compliance ----------------------------
(null, 'PRICE_NO_DISCLAIMER', 'Price stated without disclaimer',
 'Any specific dollar figure for a vehicle needs a "pricing subject to change" style disclaimer nearby.',
 'compliance', 'ai', 'high', null, null,
 'Find specific vehicle prices, monthly payments, or APR figures. Flag each one that is not accompanied by a disclaimer about pricing/availability being subject to change, or a "see dealer for details" note.',
 'suggest', true, 20),

(null, 'GUARANTEE_LANGUAGE', 'Absolute guarantee language',
 'Unqualified promises ("guaranteed approval", "lowest price anywhere", "everyone qualifies") create advertising-compliance exposure.',
 'compliance', 'regex', 'critical',
 '\b(guaranteed\s+(?:approval|financing|credit)|everyone\s+(?:is\s+)?(?:approved|qualifies)|lowest\s+price(?:s)?\s+(?:anywhere|in\s+the\s+(?:state|country|nation))|no\s+credit\s+check\s+(?:required|needed)|100%\s+approval)\b',
 null, null, 'none', true, 21),

(null, 'SUPERLATIVE_UNSUPPORTED', 'Unsupported superlative claim',
 '"#1 dealer", "best in the region", "award-winning" need a cited source or they read as puffery.',
 'accuracy', 'ai', 'high', null, null,
 'Flag superlative or ranking claims about the dealership (#1, best, largest, top-rated, award-winning) that are not attributed to a named source, award body, or year. Suggest attribution or removal.',
 'suggest', true, 22),

(null, 'SPEC_UNVERIFIED', 'Vehicle spec needs verification',
 'Horsepower, towing capacity, MPG, seating and range figures must match the manufacturer''s published numbers.',
 'accuracy', 'ai', 'high', null, null,
 'Extract every numeric vehicle specification (hp, lb-ft, MPG, towing lbs, range, seating, cargo cu ft) with the year/make/model it is attributed to. These are handed to the fact-verification step.',
 'none', true, 23),

(null, 'MPG_NO_EPA_QUALIFIER', 'Fuel economy without EPA qualifier',
 'MPG figures should be labelled EPA-estimated and note that actual mileage varies.',
 'compliance', 'ai', 'medium', null, null,
 'Find every fuel-economy figure. Flag each one where "EPA", "EPA-estimated", or an "actual mileage will vary" note does not appear in the same paragraph.',
 'suggest', true, 24),

-- ---------- Links --------------------------------------------
(null, 'LINK_BROKEN', 'Broken or unreachable link',
 'Any link returning 4xx/5xx or failing to resolve.',
 'links', 'link', 'high', null, null, null, 'none', true, 30),

(null, 'LINK_NO_INTERNAL', 'No internal dealership link',
 'An article should link back to at least one relevant page on the dealership''s own site (inventory, VDP, service, financing).',
 'links', 'link', 'high', null, null, null, 'suggest', true, 31),

(null, 'LINK_COMPETITOR', 'Link points to a competitor',
 'Outbound links to other dealerships leak traffic and are almost always a mistake.',
 'links', 'link', 'critical', null, null, null, 'none', true, 32),

(null, 'LINK_GENERIC_ANCHOR', 'Generic anchor text',
 '"Click here", "read more", "this page" waste anchor-text signal and hurt accessibility.',
 'links', 'link', 'medium', null, null,
 'Evaluated against anchor text during link analysis.', 'suggest', true, 33),

(null, 'LINK_HTTP_INSECURE', 'Insecure http:// link',
 'Links should use https where the destination supports it.',
 'links', 'link', 'low', null, null, null, 'safe', true, 34),

(null, 'LINK_REDIRECT_CHAIN', 'Link redirects elsewhere',
 'A link that redirects should be updated to its final destination.',
 'links', 'link', 'low', null, null, null, 'suggest', true, 35),

-- ---------- Structure & SEO ----------------------------------
(null, 'LINK_NO_AUTHORITY_CITED', 'No authoritative source cited',
 'The article links out but never to a manufacturer, EPA/NHTSA, IIHS or an established review source, so specification and safety claims read as unsourced.',
 'links', 'link', 'low', null, null, null, 'suggest', true, 36),

(null, 'STRUCT_NO_H1', 'Missing or duplicated H1',
 'Exactly one H1 per article.',
 'structure', 'structural', 'high', null, null, null, 'none', true, 40),

(null, 'STRUCT_HEADING_SKIP', 'Heading level skipped',
 'Jumping from H2 to H4 breaks document outline and screen-reader navigation.',
 'structure', 'structural', 'medium', null, null, null, 'none', true, 41),

(null, 'STRUCT_WALL_OF_TEXT', 'Paragraph too long',
 'Paragraphs over ~120 words are hard to scan on mobile, where most dealership traffic lands.',
 'structure', 'structural', 'low', null, null, null, 'suggest', true, 42),

(null, 'SEO_TITLE_LENGTH', 'Title tag length out of range',
 'Titles should be roughly 30-60 characters to avoid truncation in search results.',
 'seo', 'structural', 'medium', null, null, null, 'suggest', true, 43),

(null, 'SEO_NO_META_DESCRIPTION', 'Missing meta description',
 'A 120-160 character meta description should be present.',
 'seo', 'structural', 'medium', null, null, null, 'suggest', true, 44),

(null, 'SEO_IMG_NO_ALT', 'Image missing alt text',
 'Every content image needs descriptive alt text.',
 'seo', 'structural', 'medium', null, null, null, 'suggest', true, 45),

(null, 'SEO_THIN_CONTENT', 'Article is thin',
 'Under 300 words rarely ranks or informs.',
 'seo', 'structural', 'medium', null, null, null, 'none', true, 46),

-- ---------- Style & brand ------------------------------------
(null, 'STYLE_DOUBLE_SPACE', 'Double space between sentences',
 'Single space after terminal punctuation.',
 'style', 'regex', 'info', '(?<=[.!?])[ ]{2,}(?=[A-Z])', ' ',
 null, 'safe', true, 50),

(null, 'STYLE_STRAIGHT_QUOTES', 'Straight quotes and apostrophes',
 'Use typographic quotes in published copy.',
 'style', 'regex', 'info', '["'']', null,
 'Convert to curly equivalents based on position.', 'safe', true, 51),

(null, 'STYLE_TRAILING_WHITESPACE', 'Trailing whitespace',
 'Whitespace at end of a line or paragraph.',
 'style', 'regex', 'info', '[ \t]+$', '',
 null, 'safe', true, 52),

(null, 'STYLE_PASSIVE_VOICE', 'Passive voice',
 'Active voice reads better in retail automotive copy.',
 'style', 'ai', 'low', null, null,
 'Flag passive constructions where an active rewrite is clearly better. Do not flag passives that are idiomatic or where the actor is genuinely unknown.',
 'suggest', true, 53),

(null, 'STYLE_EXCLAMATION', 'Excessive exclamation marks',
 'More than one exclamation mark per article reads as a used-car cliché.',
 'style', 'regex', 'low', '!', null,
 'Flag only if the article contains more than one.', 'suggest', true, 54),

(null, 'BRAND_MODEL_CAPITALIZATION', 'Make/model capitalization',
 'Manufacturer names and trim levels follow the maker''s own casing (e.g. RAV4, F-150, 4Runner, CR-V, ID.4).',
 'brand', 'ai', 'medium', null, null,
 'Check every make, model and trim mention against the manufacturer''s official capitalization and hyphenation. Report each deviation with the correct form.',
 'safe', true, 55),

(null, 'BRAND_DEALER_NAME', 'Dealership name inconsistent',
 'The dealership''s name must be spelled and formatted identically everywhere it appears.',
 'brand', 'ai', 'high', null, null,
 'Compare every mention of the dealership name in the article against the canonical name from the dealership record and its website. Report variants.',
 'safe', true, 56),

(null, 'FACT_NAP_MISMATCH', 'Address / phone / hours mismatch',
 'Contact details in the article must match what the dealership website publishes.',
 'accuracy', 'ai', 'critical', null, null,
 'Extract any address, phone number, or hours-of-operation in the article and compare against the crawled dealership pages. Report any mismatch with both values.',
 'suggest', true, 57)

on conflict (code) where user_id is null do update set
  title       = excluded.title,
  description = excluded.description,
  category    = excluded.category,
  kind        = excluded.kind,
  severity    = excluded.severity,
  pattern     = excluded.pattern,
  replacement = excluded.replacement,
  guidance    = excluded.guidance,
  fix_mode    = excluded.fix_mode,
  sort_order  = excluded.sort_order,
  updated_at  = now();
