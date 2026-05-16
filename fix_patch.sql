-- ================================================================
-- ZENSPACE — Fix Patch v3
-- Run this entire file in Supabase Dashboard → SQL Editor
-- ================================================================

-- ── FIX 1: Remove recursive RLS policy (infinite recursion on messaging) ──────
DROP POLICY IF EXISTS "See co-members of shared convos" ON public.conversation_members;

-- ── FIX 2: Drop old broken INSERT policies on conversations ───────────────────
DROP POLICY IF EXISTS "Any user can create a conversation"            ON public.conversations;
DROP POLICY IF EXISTS "Authenticated users can create a conversation" ON public.conversations;

-- ── FIX 3: create_direct_conversation RPC ────────────────────────────────────
-- Runs as SECURITY DEFINER so it bypasses RLS entirely.
-- Returns existing conversation_id if one already exists, else creates a new one.
CREATE OR REPLACE FUNCTION public.create_direct_conversation(other_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me          UUID := auth.uid();
  existing_id UUID;
  new_conv_id UUID;
BEGIN
  SELECT cm1.conversation_id INTO existing_id
  FROM conversation_members cm1
  JOIN conversation_members cm2
    ON cm1.conversation_id = cm2.conversation_id
  WHERE cm1.user_id = me
    AND cm2.user_id = other_user_id
  LIMIT 1;

  IF existing_id IS NOT NULL THEN
    RETURN existing_id;
  END IF;

  INSERT INTO conversations (created_at, updated_at)
  VALUES (NOW(), NOW())
  RETURNING id INTO new_conv_id;

  INSERT INTO conversation_members (conversation_id, user_id)
  VALUES (new_conv_id, me), (new_conv_id, other_user_id);

  RETURN new_conv_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_direct_conversation(UUID) TO authenticated;

-- ── FIX 4: Clean conversations INSERT policy ──────────────────────────────────
CREATE POLICY "Authenticated users can create a conversation"
  ON public.conversations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ── FIX 5: Voice sessions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.voice_sessions (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES public.servers(id)  ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (server_id, user_id)
);
ALTER TABLE public.voice_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Server members can view voice sessions" ON public.voice_sessions;
CREATE POLICY "Server members can view voice sessions"
  ON public.voice_sessions FOR SELECT
  USING (server_id IN (SELECT server_id FROM public.server_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can join voice" ON public.voice_sessions;
CREATE POLICY "Users can join voice"
  ON public.voice_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can leave voice" ON public.voice_sessions;
CREATE POLICY "Users can leave voice"
  ON public.voice_sessions FOR DELETE
  USING (auth.uid() = user_id);

-- ── FIX 6: Voice signals ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.voice_signals (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id  UUID NOT NULL REFERENCES public.servers(id)  ON DELETE CASCADE,
  from_user  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  to_user    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('offer','answer','ice')),
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.voice_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Recipient can read signals" ON public.voice_signals;
CREATE POLICY "Recipient can read signals"
  ON public.voice_signals FOR SELECT
  USING (auth.uid() = to_user);

DROP POLICY IF EXISTS "Members can send signals" ON public.voice_signals;
CREATE POLICY "Members can send signals"
  ON public.voice_signals FOR INSERT
  WITH CHECK (auth.uid() = from_user AND server_id IN (
    SELECT server_id FROM public.server_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Sender or recipient can delete signals" ON public.voice_signals;
CREATE POLICY "Sender or recipient can delete signals"
  ON public.voice_signals FOR DELETE
  USING (auth.uid() = from_user OR auth.uid() = to_user);

ALTER PUBLICATION supabase_realtime ADD TABLE public.voice_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.voice_signals;

-- ── FIX 7: Add file_size column to messages (for file attachments) ────────────
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS file_size BIGINT;
