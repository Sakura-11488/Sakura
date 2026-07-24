-- Intermediate badge tiers.
--
-- The ladder had a cliff: after "First Page" (1 chapter) the next rung was a
-- 3-day streak / 50 chapters / level 10 / 10 series. In production every single
-- earning user had exactly ONE badge and no one had ever unlocked a second, so
-- progression felt broken. These rungs make early progress legible.
--
-- reading-progress-ingest OR-matches criteria (chapters | series | level |
-- streak) on every ingest, so existing users retroactively unlock everything
-- they already qualify for on their next read.
insert into public.badges (code, title, description, icon, tier, criteria, sort_order) values
  ('streak_2',    'Back for More', 'Read on two days in a row',      'flame',   'bronze', '{"streak":2}'::jsonb,    2),
  ('chapters_5',  'Warming Up',    'Read 5 chapters',                 'book',    'bronze', '{"chapters":5}'::jsonb,  3),
  ('chapters_10', 'Regular',       'Read 10 chapters',                'book',    'bronze', '{"chapters":10}'::jsonb, 5),
  ('series_3',    'Sampler',       'Read across 3 different series',  'compass', 'bronze', '{"series":3}'::jsonb,    6),
  ('level_3',     'Apprentice',    'Reach level 3',                   'star',    'bronze', '{"level":3}'::jsonb,     7),
  ('chapters_25', 'Page Turner',   'Read 25 chapters',                'run',     'bronze', '{"chapters":25}'::jsonb, 8),
  ('series_5',    'Wanderer',      'Read across 5 different series',  'compass', 'silver', '{"series":5}'::jsonb,    9),
  ('level_5',     'Adept',         'Reach level 5',                   'star',    'silver', '{"level":5}'::jsonb,    11)
on conflict (code) do nothing;

-- Re-space the pre-existing badges so the whole ladder reads in difficulty order.
update public.badges set sort_order = 1  where code = 'first_read';
update public.badges set sort_order = 4  where code = 'streak_3';
update public.badges set sort_order = 10 where code = 'streak_7';
update public.badges set sort_order = 12 where code = 'chapters_50';
update public.badges set sort_order = 13 where code = 'explorer';
update public.badges set sort_order = 14 where code = 'level_10';
update public.badges set sort_order = 15 where code = 'streak_30';
update public.badges set sort_order = 16 where code = 'chapters_500';
