// Supabase connection and the small API the game and teacher pages use.
// The publishable key is meant to be public; every rule is enforced by the
// database (row level security + functions in supabase/schema.sql).

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export const SUPABASE_URL = 'https://vzoxxjbvqjstghbdfnjg.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_3S2Bx_a6k17A1xyHS6fKDg_DWrw9O7n';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Students have usernames, not email addresses. Supabase Auth needs an email,
// so each username maps to an internal address that never receives mail.
const EMAIL_DOMAIN = 'accounts.scienceworld.app';
const toEmail = (username) => `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;

export const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/;

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export const api = {
  async signUp({ username, password, firstName, lastName, role = 'student' }) {
    const u = username.trim().toLowerCase();
    if (!USERNAME_RE.test(u)) throw new Error('Usernames use 3–30 lowercase letters, numbers, dots, dashes or underscores.');
    const { error } = await sb.auth.signUp({
      email: toEmail(u), password,
      options: { data: { username: u, first_name: firstName.trim(), last_name: lastName.trim(), role } },
    });
    if (error) throw new Error(friendly(error.message));
  },
  async logIn(username, password) {
    const { error } = await sb.auth.signInWithPassword({ email: toEmail(username), password });
    if (error) throw new Error(friendly(error.message));
  },
  logOut: () => sb.auth.signOut(),
  async session() { return (await sb.auth.getSession()).data.session; },

  profile: () => rpc('my_profile'),
  releasedSets: () => rpc('list_released_sets'),
  startRace: (setId) => rpc('start_race', { p_set_id: setId }),
  submitAnswer: (raceId, questionId, choice, requestId) =>
    rpc('submit_answer', { p_race_id: raceId, p_question_id: questionId, p_choice: choice, p_request_id: requestId }),
  finishSolo: (raceId, botName) => rpc('finish_solo_race', { p_race_id: raceId, p_bot_name: botName }),
  raceSummary: (raceId) => rpc('race_summary', { p_race_id: raceId }),

  // Teacher
  students: () => rpc('teacher_students'),
  setStatus: (userId, status) => rpc('set_account_status', { p_user: userId, p_status: status }),
  async sets() {
    const { data, error } = await sb.from('question_sets').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  },
  async createSet(set) {
    const { error } = await sb.from('question_sets').insert(set);
    if (error) throw new Error(error.message);
  },
  async updateSet(id, patch) {
    const { error } = await sb.from('question_sets').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
  },
  async deleteSet(id) {
    const { error } = await sb.from('question_sets').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },
};

function friendly(msg) {
  if (/invalid login credentials/i.test(msg)) return 'Username or password is wrong.';
  if (/already registered/i.test(msg)) return 'That username is taken. Choose another one.';
  if (/password should be at least/i.test(msg)) return 'Passwords need at least 6 characters.';
  if (/email not confirmed/i.test(msg)) return 'This account is waiting for email confirmation. Ask your teacher.';
  return msg;
}
