-- LinLearn Supabase Schema
-- Run in Supabase SQL Editor

-- Profiles (extends auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text,
  avatar_url text,
  created_at timestamptz default now()
);

-- Progress / gamification
create table if not exists public.progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade unique,
  xp integer not null default 0,
  streak integer not null default 0,
  level text not null default 'Beginner',
  last_active date default current_date
);

-- Quiz results
create table if not exists public.quiz_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null,
  score integer not null,
  total integer not null,
  difficulty text not null,
  created_at timestamptz default now()
);

-- Command history
create table if not exists public.command_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  query text not null,
  command text not null,
  explanation text,
  risk_level text,
  created_at timestamptz default now()
);

-- Shell scripts
create table if not exists public.scripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  description text not null,
  script text not null,
  created_at timestamptz default now()
);

-- Mock interview sessions
create table if not exists public.interview_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  topic text not null,
  total_questions integer not null,
  score integer not null,
  feedback text,
  created_at timestamptz default now()
);

-- Cheat sheets
create table if not exists public.cheatsheets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  topic text not null,
  content text not null,
  created_at timestamptz default now()
);

-- Indexes
create index if not exists idx_progress_user_id on public.progress(user_id);
create index if not exists idx_quiz_results_user_id on public.quiz_results(user_id);
create index if not exists idx_command_history_user_id on public.command_history(user_id);
create index if not exists idx_scripts_user_id on public.scripts(user_id);
create index if not exists idx_interview_sessions_user_id on public.interview_sessions(user_id);
create index if not exists idx_cheatsheets_user_id on public.cheatsheets(user_id);
create index if not exists idx_command_history_created_at on public.command_history(created_at desc);

-- Auto-create profile + progress on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  );
  insert into public.progress (user_id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- RLS
alter table public.profiles enable row level security;
alter table public.progress enable row level security;
alter table public.quiz_results enable row level security;
alter table public.command_history enable row level security;
alter table public.scripts enable row level security;
alter table public.interview_sessions enable row level security;
alter table public.cheatsheets enable row level security;

-- Profiles policies
create policy "Users read own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Users insert own profile" on public.profiles for insert with check (auth.uid() = id);

-- Progress policies
create policy "Users read own progress" on public.progress for select using (auth.uid() = user_id);
create policy "Users update own progress" on public.progress for update using (auth.uid() = user_id);
create policy "Users insert own progress" on public.progress for insert with check (auth.uid() = user_id);

-- Quiz results policies
create policy "Users read own quiz_results" on public.quiz_results for select using (auth.uid() = user_id);
create policy "Users insert own quiz_results" on public.quiz_results for insert with check (auth.uid() = user_id);

-- Command history policies
create policy "Users read own command_history" on public.command_history for select using (auth.uid() = user_id);
create policy "Users insert own command_history" on public.command_history for insert with check (auth.uid() = user_id);
create policy "Users delete own command_history" on public.command_history for delete using (auth.uid() = user_id);

-- Scripts policies
create policy "Users read own scripts" on public.scripts for select using (auth.uid() = user_id);
create policy "Users insert own scripts" on public.scripts for insert with check (auth.uid() = user_id);

-- Interview sessions policies
create policy "Users read own interview_sessions" on public.interview_sessions for select using (auth.uid() = user_id);
create policy "Users insert own interview_sessions" on public.interview_sessions for insert with check (auth.uid() = user_id);

-- Cheatsheets policies
create policy "Users read own cheatsheets" on public.cheatsheets for select using (auth.uid() = user_id);
create policy "Users insert own cheatsheets" on public.cheatsheets for insert with check (auth.uid() = user_id);

-- Storage bucket for avatars (run separately if needed):
-- insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
