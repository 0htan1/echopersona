import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, get, run, tx, hasFts } from '../db/index.js';
import { getPublicUser } from './auth.js';

/** Full per-user data export (JSON). Never includes decrypted secrets. */
export function buildExport(userId) {
  const user = getPublicUser(userId);
  const personas = all('SELECT * FROM personas WHERE user_id = ?', [userId]);
  const out = {
    exportedAt: new Date().toISOString(),
    account: user,
    personas: personas.map((p) => {
      const profile = get('SELECT * FROM profiles WHERE persona_id = ? AND is_active = 1', [p.id]);
      return {
        ...stripInternal(p),
        profile: profile ? JSON.parse(profile.data_json) : null,
        memories: all('SELECT kind,content,salience,confidence,source_type,source_ref,created_at FROM memories WHERE persona_id = ? AND is_deleted = 0', [p.id]),
        chats: all('SELECT id,title,created_at,updated_at FROM chats WHERE persona_id = ?', [p.id]).map((c) => ({
          ...c,
          messages: all('SELECT role,content,ts,created_at FROM messages WHERE chat_id = ? ORDER BY created_at', [c.id]),
        })),
        imports: all('SELECT original_name,status,message_total,message_new,created_at FROM import_files WHERE persona_id = ?', [p.id]),
      };
    }),
    llmConfigs: all('SELECT label,provider,base_url,model,is_default,created_at FROM llm_configs WHERE user_id = ?', [userId])
      .map((c) => ({ ...c, apiKey: '[已加密存储，出于安全考虑不导出]' })),
    ttsConfigs: all('SELECT label,kind,base_url,model,is_default,created_at FROM tts_configs WHERE user_id = ?', [userId])
      .map((c) => ({ ...c, apiKey: '[已加密存储，出于安全考虑不导出]' })),
    voiceRefs: all('SELECT name,ref_text,provider,consent,created_at FROM voice_refs WHERE user_id = ?', [userId]),
  };
  return out;
}

function stripInternal(row) {
  const { user_id, ...rest } = row;
  return rest;
}

/** Delete the account and every byte of its data (DB rows + files on disk). */
export function purgeUser(userId) {
  const personas = all('SELECT id FROM personas WHERE user_id = ?', [userId]);
  const files = new Set();

  for (const p of personas) {
    for (const r of all('SELECT stored_path FROM import_files WHERE persona_id = ?', [p.id])) {
      if (r.stored_path) files.add(r.stored_path);
    }
    for (const r of all('SELECT file_path FROM tts_audio WHERE persona_id = ?', [p.id])) {
      if (r.file_path) files.add(r.file_path);
    }
    const av = get('SELECT avatar_path FROM personas WHERE id = ?', [p.id])?.avatar_path;
    if (av) files.add(path.join(config.avatarDir, av));
  }
  for (const r of all('SELECT file_path FROM voice_refs WHERE user_id = ?', [userId])) {
    if (r.file_path) files.add(r.file_path);
  }
  const userAv = get('SELECT avatar_path FROM users WHERE id = ?', [userId])?.avatar_path;
  if (userAv) files.add(path.join(config.avatarDir, userAv));

  tx(() => {
    const personaIds = personas.map((p) => p.id);
    if (hasFts()) {
      for (const pid of personaIds) {
        run('DELETE FROM memories_fts WHERE persona_id = ?', [pid]);
        run('DELETE FROM chunks_fts WHERE persona_id = ?', [pid]);
      }
    }
    // ON DELETE CASCADE handles the rest, but be explicit for clarity
    run('DELETE FROM messages WHERE user_id = ?', [userId]);
    run('DELETE FROM memory_chunks WHERE user_id = ?', [userId]);
    run('DELETE FROM memories WHERE user_id = ?', [userId]);
    run('DELETE FROM profiles WHERE user_id = ?', [userId]);
    run('DELETE FROM tts_audio WHERE user_id = ?', [userId]);
    run('DELETE FROM import_files WHERE user_id = ?', [userId]);
    run('DELETE FROM chats WHERE user_id = ?', [userId]);
    run('DELETE FROM personas WHERE user_id = ?', [userId]);
    run('DELETE FROM voice_refs WHERE user_id = ?', [userId]);
    run('DELETE FROM llm_configs WHERE user_id = ?', [userId]);
    run('DELETE FROM tts_configs WHERE user_id = ?', [userId]);
    run('DELETE FROM jobs WHERE user_id = ?', [userId]);
    run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    run('UPDATE users SET deleted_at = ?, status = ?, email = ?, password_hash = ?, display_name = ?, avatar_path = NULL WHERE id = ?',
      [Date.now(), 'deleted', `deleted+${userId}@invalid.local`, 'x', '已注销用户', userId]);
  });

  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
  return { deletedFiles: files.size, personas: personas.length };
}
