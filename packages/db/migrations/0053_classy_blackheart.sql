ALTER TABLE `agents` ADD `avatar` text DEFAULT '{"color":"slate","glyph":"?"}' NOT NULL;
--> statement-breakpoint
-- Backfill with the rule of `defaultAgentAvatar`: the glyph is the first character of the name, upper-cased when ASCII, and the colour is picked by that character's code point.
UPDATE `agents` SET `avatar` = json_object(
  'color',
  CASE coalesce(unicode(substr(`name`, 1, 1)), 0) % 8
    WHEN 0 THEN 'slate'
    WHEN 1 THEN 'red'
    WHEN 2 THEN 'orange'
    WHEN 3 THEN 'amber'
    WHEN 4 THEN 'green'
    WHEN 5 THEN 'teal'
    WHEN 6 THEN 'blue'
    ELSE 'violet'
  END,
  'glyph',
  coalesce(nullif(upper(substr(`name`, 1, 1)), ''), '?')
);
