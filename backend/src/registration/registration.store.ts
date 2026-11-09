import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type QueryResultRow } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { ACCOUNT_CREDIT_COLUMNS } from '../credits/credit-ledger';
import {
  accountView,
  ACCOUNT_SESSION_SECONDS,
  type AccountRow,
} from './account-session';
import type { ProfileDetailsDto } from './profile.dto';
import type { Channel } from './verification-delivery';
import { RegistrationError } from './registration-error';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
  SESSION_SECONDS,
  TERMS_VERSION,
} from './registration-settings';

interface UserRow extends QueryResultRow {
  id: string;
  username: string;
  email: string;
  phone: string;
  email_verified: boolean;
  phone_verified: boolean;
}

interface ProfileRow extends AccountRow {
  full_name: string;
  country: string;
  city: string;
  terms_version: string | null;
  terms_accepted_at: Date | null;
}
function profileView(user: ProfileRow) {
  return {
    account: accountView(user),
    details: {
      fullName: user.full_name,
      country: user.country,
      city: user.city,
    },
    participationTerms: {
      version: user.terms_version,
      acceptedAt: user.terms_accepted_at?.toISOString() ?? null,
    },
  };
}

export function registrationView(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    status: 'verification_required' as const,
    emailVerified: user.email_verified ?? false,
    phoneVerified: user.phone_verified ?? false,
    delivery: { email: 'unavailable' as const, phone: 'unavailable' as const },
  };
}

@Injectable()
export class RegistrationStore implements OnModuleDestroy {
  private readonly pool: Pool | undefined;
  constructor(@Inject(REGISTRATION_SETTINGS) settings: RegistrationSettings) {
    if (settings.databaseUrl) {
      this.pool = new Pool({
        connectionString: settings.databaseUrl,
        max: 5,
        connectionTimeoutMillis: 3000,
        query_timeout: 5000,
      });
      // Idle connection failures must not crash the process or log credentials.
      this.pool.on('error', () => {});
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private database(): Pool {
    if (!this.pool)
      throw new RegistrationError('registration_unavailable', 503);
    return this.pool;
  }

  async consumeAttempt(key: string): Promise<void> {
    const result = await this.database().query(
      `INSERT INTO registration_limits (key, bucket, attempts)
       VALUES ($1, date_trunc('hour', now()), 1)
       ON CONFLICT (key, bucket) DO UPDATE SET attempts = registration_limits.attempts + 1
       WHERE registration_limits.attempts < 10 RETURNING attempts`,
      [key],
    );
    if (!result.rowCount)
      throw new RegistrationError('registration_limited', 429);
    await this.database().query(
      "DELETE FROM registration_limits WHERE bucket < now() - interval '2 hours'",
    );
  }

  async create(input: {
    id: string;
    username: string;
    usernameKey: string;
    passwordHash: string;
    email: string;
    phone: string;
    tokenHash?: string;
    accountTokenHash: string;
    kind?: 'registered' | 'demo';
    previousAccountHash?: string;
  }) {
    const client = await this.database().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<UserRow & AccountRow>(
        // Temporary owner-approved email bypass while Resend domain setup is pending.
        `INSERT INTO users (id, username, username_key, password_hash, email, phone, terms_version, terms_accepted_at, account_kind, demo_credits_minor, email_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8='registered' THEN now() ELSE NULL END,$8,$9,$8='registered') RETURNING *`,
        [
          input.id,
          input.username,
          input.usernameKey,
          input.passwordHash,
          input.email,
          input.phone,
          input.kind === 'demo' ? null : TERMS_VERSION,
          input.kind ?? 'registered',
          0,
        ],
      );
      if (input.tokenHash)
        await client.query(
          `INSERT INTO registration_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,now() + $3 * interval '1 second')`,
          [input.tokenHash, input.id, SESSION_SECONDS],
        );
      await client.query(
        `INSERT INTO account_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now()+$3*interval '1 second')`,
        [input.accountTokenHash, input.id, ACCOUNT_SESSION_SECONDS],
      );
      if (input.previousAccountHash)
        await client.query('DELETE FROM account_sessions WHERE token_hash=$1', [
          input.previousAccountHash,
        ]);
      const account = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_CREDIT_COLUMNS} FROM users u WHERE u.id=$1`,
        [input.id],
      );
      await client.query('COMMIT');
      return {
        registration: registrationView(rows[0]!),
        account: accountView(account.rows[0]!),
      };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      if (error instanceof Error && 'code' in error && error.code === '23505')
        throw new RegistrationError('registration_conflict', 409);
      throw error;
    } finally {
      client.release();
    }
  }

  async findSession(tokenHash: string) {
    const { rows } = await this.database().query<UserRow>(
      `SELECT u.id, u.username, u.email, u.phone, u.email_verified, u.phone_verified FROM registration_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'verification_required' AND u.account_kind='registered' AND u.registration_dismissed_at IS NULL`,
      [tokenHash],
    );
    return rows[0] ? registrationView(rows[0]) : null;
  }
  async findUser(id: string) {
    const { rows } = await this.database().query<UserRow>(
      'SELECT id, username, email, phone, email_verified, phone_verified FROM users WHERE id=$1',
      [id],
    );
    return rows[0] ? registrationView(rows[0]) : null;
  }

  async findLogin(usernameKey: string) {
    const { rows } = await this.database().query<{
      id: string;
      password_hash: string;
      account_kind: string;
    }>(
      'SELECT id,password_hash,account_kind FROM users WHERE username_key=$1',
      [usernameKey],
    );
    return rows[0] ?? null;
  }
  async issueAccountSession(id: string, hash: string, previousHash?: string) {
    const client = await this.database().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]);
      await client.query(
        `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3*interval '1 second')`,
        [hash, id, ACCOUNT_SESSION_SECONDS],
      );
      if (previousHash)
        await client.query('DELETE FROM account_sessions WHERE token_hash=$1', [
          previousHash,
        ]);
      const { rows } = await client.query<AccountRow>(
        `UPDATE users u SET registration_dismissed_at=coalesce(registration_dismissed_at,now()) WHERE id=$1 RETURNING ${ACCOUNT_CREDIT_COLUMNS}`,
        [id],
      );
      await client.query('COMMIT');
      return accountView(rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async pendingRegistration(id: string) {
    const { rows } = await this.database().query<UserRow>(
      "SELECT * FROM users WHERE id=$1 AND account_kind='registered' AND registration_dismissed_at IS NULL",
      [id],
    );
    return rows[0] ? registrationView(rows[0]) : null;
  }
  async dismissRegistration(hash: string) {
    const result = await this.database().query(
      `UPDATE users u SET registration_dismissed_at=coalesce(u.registration_dismissed_at,now())
       FROM account_sessions s WHERE s.user_id=u.id AND s.token_hash=$1 AND s.expires_at>now() RETURNING u.id`,
      [hash],
    );
    return !!result.rowCount;
  }

  async findAccountSession(hash: string) {
    const { rows } = await this.database().query<AccountRow>(
      `SELECT ${ACCOUNT_CREDIT_COLUMNS} FROM account_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at > now()`,
      [hash],
    );
    return rows[0] ? accountView(rows[0]) : null;
  }

  async profile(hash: string) {
    const { rows } = await this.database().query<ProfileRow>(
      `SELECT ${ACCOUNT_CREDIT_COLUMNS} FROM account_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [hash],
    );
    const user = rows[0];
    return user ? profileView(user) : null;
  }

  async saveProfile(hash: string, details: ProfileDetailsDto) {
    const { rows } = await this.database().query<ProfileRow>(
      `UPDATE users u SET full_name=$2,country=$3,city=$4 FROM account_sessions s
       WHERE s.user_id=u.id AND s.token_hash=$1 AND s.expires_at>now() RETURNING ${ACCOUNT_CREDIT_COLUMNS}`,
      [hash, details.fullName, details.country, details.city],
    );
    const user = rows[0];
    return user ? profileView(user) : null;
  }

  async resumeAccount(registrationHash: string, accountHash: string) {
    const { rows } = await this.database().query<AccountRow>(
      `WITH issued AS (
        INSERT INTO account_sessions (token_hash,user_id,expires_at)
        SELECT $2,s.user_id,now()+$3*interval '1 second' FROM registration_sessions s
        JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.account_kind='registered'
        RETURNING user_id
      ) SELECT ${ACCOUNT_CREDIT_COLUMNS} FROM users u JOIN issued i ON i.user_id=u.id`,
      [registrationHash, accountHash, ACCOUNT_SESSION_SECONDS],
    );
    return rows[0] ? accountView(rows[0]) : null;
  }

  async revokeSessions(accountHash: string, registrationHash: string) {
    // One statement ensures logout cannot revoke only one of the two credentials.
    await this.database().query(
      `WITH removed AS (DELETE FROM account_sessions WHERE token_hash=$1)
       DELETE FROM registration_sessions WHERE token_hash=$2`,
      [accountHash, registrationHash],
    );
  }

  async challengeStatus(id: string) {
    const { rows } = await this.database().query<{
      channel: Channel;
      send_state: 'sending' | 'sent' | 'failed' | 'verified';
      expires_at: Date;
      retry_after: number;
    }>(
      `SELECT channel, send_state, expires_at,
      ceil(greatest(0,extract(epoch FROM (greatest(resend_at,
        CASE WHEN send_count >= 10 THEN send_window + interval '1 hour' ELSE resend_at END) - clock_timestamp()))))::int AS retry_after
      FROM verification_challenges WHERE user_id=$1`,
      [id],
    );
    return rows;
  }

  async reserveCode(input: {
    userId: string;
    channel: Channel;
    requestId: string;
    digest: string;
    initialOnly: boolean;
  }) {
    const client = await this.database().connect();
    try {
      await client.query('BEGIN');
      const user = (
        await client.query<
          UserRow & Pick<AccountRow, 'account_kind'> & { db_now: Date }
        >(
          'SELECT *, clock_timestamp() AS db_now FROM users WHERE id=$1 FOR UPDATE',
          [input.userId],
        )
      ).rows[0];
      if (!user || user.account_kind === 'demo')
        throw new RegistrationError('registration_session_expired', 401);
      if (
        user[input.channel === 'email' ? 'email_verified' : 'phone_verified']
      ) {
        await client.query('COMMIT');
        return null;
      }
      const row = (
        await client.query<{
          resend_at: Date;
          send_window: Date;
          send_count: number;
        }>(
          'SELECT * FROM verification_challenges WHERE user_id=$1 AND channel=$2 FOR UPDATE',
          [input.userId, input.channel],
        )
      ).rows[0];
      if (input.initialOnly && row) {
        await client.query('COMMIT');
        return null;
      }
      const now = user.db_now;
      const sameWindow =
        row && now.getTime() < row.send_window.getTime() + 3600000;
      const retryAt = Math.max(
        row?.resend_at.getTime() ?? 0,
        sameWindow && row.send_count >= 10
          ? row.send_window.getTime() + 3600000
          : 0,
      );
      if (retryAt > now.getTime())
        throw new RegistrationError(
          'verification_cooldown',
          429,
          Math.ceil((retryAt - now.getTime()) / 1000),
        );
      const count = sameWindow ? row.send_count + 1 : 1;
      const window = sameWindow ? row.send_window : now;
      await client.query(
        `INSERT INTO verification_challenges
        (user_id,channel,request_id,code_digest,expires_at,resend_at,attempts,send_state,send_window,send_count)
        VALUES ($1,$2,$3,$4,$5::timestamptz + interval '10 minutes',$5::timestamptz + interval '60 seconds',0,'sending',$6,$7)
        ON CONFLICT (user_id,channel) DO UPDATE SET request_id=EXCLUDED.request_id,code_digest=EXCLUDED.code_digest,
        expires_at=EXCLUDED.expires_at,resend_at=EXCLUDED.resend_at,attempts=0,send_state='sending',send_window=EXCLUDED.send_window,send_count=EXCLUDED.send_count`,
        [
          input.userId,
          input.channel,
          input.requestId,
          input.digest,
          now,
          window,
          count,
        ],
      );
      await client.query('COMMIT');
      return user[input.channel];
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async finishSend(
    userId: string,
    channel: Channel,
    requestId: string,
    success: boolean,
  ) {
    await this.database().query(
      `UPDATE verification_challenges SET send_state=$4,
      code_digest=CASE WHEN $5 THEN code_digest ELSE NULL END
      WHERE user_id=$1 AND channel=$2 AND request_id=$3 AND send_state='sending'`,
      [userId, channel, requestId, success ? 'sent' : 'failed', success],
    );
  }

  async verifyCode(
    userId: string,
    channel: Channel,
    digest: (requestId: string) => string,
  ): Promise<boolean> {
    const client = await this.database().connect();
    try {
      await client.query('BEGIN');
      const user = (
        await client.query<
          UserRow & Pick<AccountRow, 'account_kind'> & { db_now: Date }
        >(
          'SELECT *,clock_timestamp() AS db_now FROM users WHERE id=$1 FOR UPDATE',
          [userId],
        )
      ).rows[0];
      if (!user)
        throw new RegistrationError('registration_session_expired', 401);
      const field = channel === 'email' ? 'email_verified' : 'phone_verified';
      if (user[field]) {
        await client.query('COMMIT');
        return true;
      }
      const row = (
        await client.query<{
          request_id: string;
          code_digest: string | null;
          expires_at: Date;
          attempts: number;
          send_state: string;
        }>(
          'SELECT * FROM verification_challenges WHERE user_id=$1 AND channel=$2 FOR UPDATE',
          [userId, channel],
        )
      ).rows[0];
      let valid = false;
      if (
        row?.code_digest &&
        row.send_state === 'sent' &&
        row.expires_at > user.db_now &&
        row.attempts < 5
      ) {
        valid = timingSafeEqual(
          Buffer.from(row.code_digest, 'hex'),
          Buffer.from(digest(row.request_id), 'hex'),
        );
        await client.query(
          'UPDATE verification_challenges SET attempts=attempts+1 WHERE user_id=$1 AND channel=$2',
          [userId, channel],
        );
      }
      if (valid) {
        await client.query(`UPDATE users SET ${field}=true WHERE id=$1`, [
          userId,
        ]);
        await client.query(
          "UPDATE verification_challenges SET code_digest=NULL,send_state='verified' WHERE user_id=$1 AND channel=$2",
          [userId, channel],
        );
      }
      // Invalid attempts must commit too; rolling them back would remove the attempt limit.
      await client.query('COMMIT');
      return valid;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
