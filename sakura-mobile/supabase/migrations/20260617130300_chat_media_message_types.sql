-- Allow gif and sticker message types (required for Giphy chat media).
alter table public.chat_messages
  drop constraint if exists chat_messages_message_type_check;

alter table public.chat_messages
  add constraint chat_messages_message_type_check
  check (message_type = any (array['text', 'image', 'system', 'gif', 'sticker']));
