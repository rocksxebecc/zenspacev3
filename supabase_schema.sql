-- ================================================================
-- ZENSPACE — Supabase Database Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ================================================================

-- ── 1. PROFILES TABLE ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  bio           TEXT DEFAULT '',
  avatar_color  TEXT DEFAULT '#1A1A1A',
  avatar_emoji  TEXT DEFAULT '🎓',
  university    TEXT DEFAULT '',
  course        TEXT DEFAULT '',
  year          TEXT DEFAULT '',
  is_public     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Username must be 3–24 chars, alphanumeric + underscores only
ALTER TABLE public.profiles
  ADD CONSTRAINT username_format CHECK (username ~ '^[a-z0-9_]{3,24}$');

-- Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles are viewable by everyone"
  ON public.profiles FOR SELECT USING (TRUE);

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- ── 2. FRIEND REQUESTS TABLE ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.friend_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  message       TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sender_id, receiver_id)
);

ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see requests involving them"
  ON public.friend_requests FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

CREATE POLICY "Users can send friend requests"
  ON public.friend_requests FOR INSERT
  WITH CHECK (auth.uid() = sender_id AND sender_id != receiver_id);

CREATE POLICY "Receiver can update (accept/decline)"
  ON public.friend_requests FOR UPDATE
  USING (auth.uid() = receiver_id OR auth.uid() = sender_id);

CREATE POLICY "Users can delete their own requests"
  ON public.friend_requests FOR DELETE
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

-- ── 3. AUTO-CREATE PROFILE TRIGGER ────────────────────────────
-- Automatically creates a profile when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  base_username TEXT;
  final_username TEXT;
  counter INT := 0;
BEGIN
  -- Generate base username from email prefix
  base_username := LOWER(REGEXP_REPLACE(SPLIT_PART(NEW.email, '@', 1), '[^a-z0-9_]', '_', 'g'));
  base_username := LEFT(base_username, 20);
  IF LENGTH(base_username) < 3 THEN base_username := base_username || '_user'; END IF;
  final_username := base_username;

  -- Ensure uniqueness
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = final_username) LOOP
    counter := counter + 1;
    final_username := base_username || counter::TEXT;
  END LOOP;

  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    NEW.id,
    final_username,
    COALESCE(NEW.raw_user_meta_data->>'full_name', SPLIT_PART(NEW.email,'@',1))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 4. UPDATED_AT TRIGGER ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_friend_requests_updated_at
  BEFORE UPDATE ON public.friend_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 5. HELPER VIEW — friends list ─────────────────────────────
CREATE OR REPLACE VIEW public.friends_view AS
SELECT
  fr.id AS request_id,
  fr.status,
  fr.message,
  fr.created_at,
  CASE WHEN fr.sender_id = auth.uid() THEN fr.receiver_id ELSE fr.sender_id END AS friend_id,
  CASE WHEN fr.sender_id = auth.uid() THEN 'sent' ELSE 'received' END AS direction,
  p.username, p.display_name, p.bio, p.avatar_color, p.avatar_emoji, p.university, p.course
FROM public.friend_requests fr
JOIN public.profiles p ON p.id = (CASE WHEN fr.sender_id = auth.uid() THEN fr.receiver_id ELSE fr.sender_id END)
WHERE fr.sender_id = auth.uid() OR fr.receiver_id = auth.uid();

-- ── 6. NOTES TABLE ────────────────────────────────────────────
-- Used by dashboard.html notes section via supabase.js helpers:
--   fetchNotes(), upsertNote(), deleteNoteById()
CREATE TABLE IF NOT EXISTS public.notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title         TEXT DEFAULT '',
  body          TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

-- Users can only see their own notes
CREATE POLICY "Users can read their own notes"
  ON public.notes FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own notes
CREATE POLICY "Users can insert their own notes"
  ON public.notes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own notes
CREATE POLICY "Users can update their own notes"
  ON public.notes FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can delete their own notes
CREATE POLICY "Users can delete their own notes"
  ON public.notes FOR DELETE
  USING (auth.uid() = user_id);

-- Auto-update updated_at on notes
CREATE TRIGGER set_notes_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── DONE (Core) ───────────────────────────────────────────────
-- After running this SQL:
-- 1. Go to Supabase → Authentication → Settings → Enable "Email confirmations" if needed
-- 2. Existing users won't have profiles — they'll be prompted to set a username on first login

-- ================================================================
-- ZENSPACE — Chat Schema (append to existing schema)
-- ================================================================

-- ── CONVERSATIONS TABLE ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

-- ── CONVERSATION MEMBERS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversation_members (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES public.profiles(id)      ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ DEFAULT NOW(),
  last_read_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can see their conversations"
  ON public.conversation_members FOR SELECT
  USING (auth.uid() = user_id);

-- Allow authenticated users to insert conversation members.
-- This is needed because when creating a DM, the initiator must
-- add both themselves AND the other user to the conversation.
-- (chat.html openOrCreateConvWith() inserts rows for both users)
CREATE POLICY "Authenticated users can add conversation members"
  ON public.conversation_members FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Members can update their own row"
  ON public.conversation_members FOR UPDATE
  USING (auth.uid() = user_id);

-- Allow members to see other members of their conversations
CREATE POLICY "See co-members of shared convos"
  ON public.conversation_members FOR SELECT
  USING (
    conversation_id IN (
      SELECT conversation_id FROM public.conversation_members WHERE user_id = auth.uid()
    )
  );

-- ── MESSAGES TABLE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES public.profiles(id)      ON DELETE CASCADE,
  body            TEXT NOT NULL CHECK (LENGTH(body) > 0 AND LENGTH(body) <= 4000),
  msg_type        TEXT DEFAULT 'text' CHECK (msg_type IN ('text','image','file')),
  file_url        TEXT,
  file_name       TEXT,
  is_deleted      BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  edited_at       TIMESTAMPTZ
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read messages"
  ON public.messages FOR SELECT
  USING (
    conversation_id IN (
      SELECT conversation_id FROM public.conversation_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Members can send messages"
  ON public.messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id AND
    conversation_id IN (
      SELECT conversation_id FROM public.conversation_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Sender can edit or delete own messages"
  ON public.messages FOR UPDATE
  USING (auth.uid() = sender_id);

-- ── CONVERSATIONS RLS (via membership) ────────────────────────
CREATE POLICY "Members can view conversations"
  ON public.conversations FOR SELECT
  USING (
    id IN (SELECT conversation_id FROM public.conversation_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Any user can create a conversation"
  ON public.conversations FOR INSERT
  WITH CHECK (TRUE);

-- ── UPDATE conversations.updated_at on new message ─────────────
CREATE OR REPLACE FUNCTION public.update_conversation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.conversations SET updated_at = NOW() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_new_message ON public.messages;
CREATE TRIGGER on_new_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.update_conversation_timestamp();

-- ── Enable Realtime ────────────────────────────────────────────
-- In Supabase Dashboard → Database → Replication, enable:
-- public.messages, public.conversation_members, public.conversations
-- Or run:
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_members;

-- ================================================================
-- ZENSPACE — Servers Schema (append to existing schema)
-- ================================================================

-- ── SERVERS TABLE ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.servers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (LENGTH(name) >= 1 AND LENGTH(name) <= 40),
  description   TEXT DEFAULT '' CHECK (LENGTH(description) <= 120),
  icon_emoji    TEXT DEFAULT '🎓',
  owner_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invite_code   TEXT UNIQUE NOT NULL CHECK (invite_code ~ '^[A-Z0-9]{6}$'),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;

-- Anyone can view a server (needed to join by invite code)
CREATE POLICY "Servers are viewable by authenticated users"
  ON public.servers FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only authenticated users can create servers
CREATE POLICY "Authenticated users can create servers"
  ON public.servers FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

-- Only owner can update/delete their server
CREATE POLICY "Owner can update server"
  ON public.servers FOR UPDATE
  USING (auth.uid() = owner_id);

CREATE POLICY "Owner can delete server"
  ON public.servers FOR DELETE
  USING (auth.uid() = owner_id);

-- ── SERVER MEMBERS TABLE ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.server_members (
  id          UUID DEFAULT gen_random_uuid(),
  server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (server_id, user_id)
);

ALTER TABLE public.server_members ENABLE ROW LEVEL SECURITY;

-- Members can see other members of servers they belong to
CREATE POLICY "Members can view server membership"
  ON public.server_members FOR SELECT
  USING (
    server_id IN (
      SELECT server_id FROM public.server_members WHERE user_id = auth.uid()
    )
  );

-- Users can join a server (insert themselves)
CREATE POLICY "Users can join servers"
  ON public.server_members FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can leave (delete their own membership); owners cannot delete others
CREATE POLICY "Users can leave servers"
  ON public.server_members FOR DELETE
  USING (auth.uid() = user_id);

-- ── SERVER MESSAGES TABLE ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.server_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body        TEXT NOT NULL CHECK (LENGTH(body) >= 1 AND LENGTH(body) <= 1000),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.server_messages ENABLE ROW LEVEL SECURITY;

-- Only server members can read messages
CREATE POLICY "Server members can read messages"
  ON public.server_messages FOR SELECT
  USING (
    server_id IN (
      SELECT server_id FROM public.server_members WHERE user_id = auth.uid()
    )
  );

-- Only server members can send messages
CREATE POLICY "Server members can send messages"
  ON public.server_messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id AND
    server_id IN (
      SELECT server_id FROM public.server_members WHERE user_id = auth.uid()
    )
  );

-- ── Enable Realtime for Servers ────────────────────────────────
-- In Supabase Dashboard → Database → Replication, also enable:
-- public.server_messages, public.server_members, public.servers
-- Or run:
ALTER PUBLICATION supabase_realtime ADD TABLE public.servers;
ALTER PUBLICATION supabase_realtime ADD TABLE public.server_members;
ALTER PUBLICATION supabase_realtime ADD TABLE public.server_messages;

-- ── Enable Realtime for Friend Requests ────────────────────────
-- profile.html subscribes to postgres_changes on friend_requests
-- for real-time incoming request notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.friend_requests;

-- ── Enable Realtime for Notes ──────────────────────────────────
-- (optional, for future multi-device sync)
ALTER PUBLICATION supabase_realtime ADD TABLE public.notes;
