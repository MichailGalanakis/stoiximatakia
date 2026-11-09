import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { ProfileDetailsDto } from './profile.dto';
import type { RegisterDto } from './register.dto';
import type { LoginDto } from './login.dto';
import { hashPassword, verifyPassword } from './password';
import { RegistrationError } from './registration-error';
import { RegistrationStore } from './registration.store';
import { VerificationService } from './verification.service';
import { TERMS_VERSION } from './registration-settings';

export const tokenDigest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class RegistrationService {
  private hashing = 0;
  constructor(
    @Inject(RegistrationStore) private readonly store: RegistrationStore,
    @Inject(VerificationService)
    private readonly verification: VerificationService,
  ) {}

  async register(input: RegisterDto, ip: string, previousToken?: string) {
    const username = input.username.trim().normalize('NFC');
    const email = input.email.trim().toLowerCase();
    const phone = parsePhoneNumberFromString(input.phone.trim(), {
      defaultCountry: 'GR',
      extract: false,
    });
    if (
      !/^[\p{L}\p{N}_.-]{3,30}$/u.test(username) ||
      !isEmail(email) ||
      email.endsWith('@demo.invalid') ||
      !phone?.isValid() ||
      phone.ext ||
      !input.termsAccepted
    )
      throw new RegistrationError('invalid_registration', 400);
    if (input.termsVersion !== TERMS_VERSION)
      throw new RegistrationError('terms_changed', 409);
    try {
      await this.store.consumeAttempt(tokenDigest(ip));
      if (this.hashing >= 2)
        throw new RegistrationError('registration_unavailable', 503);
      this.hashing++;
      try {
        const passwordHash = await hashPassword(input.password);
        const token = randomBytes(32).toString('hex');
        const accountToken = randomBytes(32).toString('hex');
        const { registration, account } = await this.store.create({
          id: randomUUID(),
          username,
          usernameKey: username.toLowerCase(),
          passwordHash,
          email,
          phone: phone.number,
          tokenHash: tokenDigest(token),
          accountTokenHash: tokenDigest(accountToken),
          ...(previousToken
            ? { previousAccountHash: tokenDigest(previousToken) }
            : {}),
        });
        return {
          registration: await this.verification.describe(registration),
          token,
          accountToken,
          account,
        };
      } finally {
        this.hashing--;
      }
    } catch (error: unknown) {
      if (error instanceof RegistrationError) throw error;
      throw new RegistrationError('registration_unavailable', 503);
    }
  }

  async account(token: string | undefined) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    try {
      return await this.store.findAccountSession(tokenDigest(token));
    } catch {
      throw new RegistrationError('registration_unavailable', 503);
    }
  }

  async login(input: LoginDto, ip: string, previousToken?: string) {
    const usernameKey = input.username.trim().normalize('NFC').toLowerCase();
    try {
      await this.store.consumeAttempt(tokenDigest('login-ip:' + ip));
      await this.store.consumeAttempt(tokenDigest('login-user:' + usernameKey));
      if (this.hashing >= 2)
        throw new RegistrationError('registration_unavailable', 503);
      this.hashing++;
      try {
        const user = await this.store.findLogin(usernameKey);
        let valid = false;
        if (user?.account_kind === 'registered')
          valid = await verifyPassword(input.password, user.password_hash);
        else await hashPassword(input.password);
        if (!valid || !user)
          throw new RegistrationError('invalid_credentials', 401);
        const token = randomBytes(32).toString('hex');
        const account = await this.store.issueAccountSession(
          user.id,
          tokenDigest(token),
          previousToken ? tokenDigest(previousToken) : undefined,
        );
        return { account, token };
      } finally {
        this.hashing--;
      }
    } catch (error) {
      if (error instanceof RegistrationError) throw error;
      throw new RegistrationError('registration_unavailable', 503);
    }
  }
  async dismissRegistration(token?: string) {
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new RegistrationError('account_session_expired', 401);
    try {
      if (!(await this.store.dismissRegistration(tokenDigest(token))))
        throw new RegistrationError('account_session_expired', 401);
    } catch (error) {
      if (error instanceof RegistrationError) throw error;
      throw new RegistrationError('registration_unavailable', 503);
    }
  }

  async profile(token: string | undefined, details?: ProfileDetailsDto) {
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new RegistrationError('account_session_expired', 401);
    try {
      const profile = details
        ? await this.store.saveProfile(tokenDigest(token), {
            fullName: details.fullName.trim().normalize('NFC'),
            country: details.country.trim().normalize('NFC'),
            city: details.city.trim().normalize('NFC'),
          })
        : await this.store.profile(tokenDigest(token));
      if (!profile) throw new RegistrationError('account_session_expired', 401);
      return profile;
    } catch (error) {
      if (error instanceof RegistrationError) throw error;
      throw new RegistrationError('registration_unavailable', 503);
    }
  }

  async demo(ip: string, existingToken?: string) {
    const existing = await this.account(existingToken);
    if (existing) return { account: existing, token: null };
    try {
      await this.store.consumeAttempt(tokenDigest(ip));
      if (this.hashing >= 2)
        throw new RegistrationError('registration_unavailable', 503);
      this.hashing++;
      try {
        const id = randomUUID();
        const username = 'Demo_' + randomBytes(8).toString('hex');
        const token = randomBytes(32).toString('hex');
        const { account } = await this.store.create({
          id,
          username,
          usernameKey: username.toLowerCase(),
          passwordHash: await hashPassword(
            randomBytes(32).toString('base64url'),
          ),
          email: id + '@demo.invalid',
          phone: 'demo:' + id,
          accountTokenHash: tokenDigest(token),
          kind: 'demo',
        });
        return { account, token };
      } finally {
        this.hashing--;
      }
    } catch (error) {
      if (error instanceof RegistrationError) throw error;
      throw new RegistrationError('registration_unavailable', 503);
    }
  }

  async resumeSignIn(registrationToken?: string, existingToken?: string) {
    const existing = await this.account(existingToken);
    if (existing) return { account: existing, token: null };
    if (!registrationToken || !/^[a-f0-9]{64}$/.test(registrationToken))
      throw new RegistrationError('registration_session_expired', 401);
    try {
      const token = randomBytes(32).toString('hex');
      const account = await this.store.resumeAccount(
        tokenDigest(registrationToken),
        tokenDigest(token),
      );
      if (!account)
        throw new RegistrationError('registration_session_expired', 401);
      return { account, token };
    } catch (error) {
      if (error instanceof RegistrationError) throw error;
      throw new RegistrationError('registration_unavailable', 503);
    }
  }

  async logout(accountToken?: string, registrationToken?: string) {
    try {
      await this.store.revokeSessions(
        tokenDigest(accountToken ?? ''),
        tokenDigest(registrationToken ?? ''),
      );
    } catch {
      throw new RegistrationError('registration_unavailable', 503);
    }
  }

  async resume(token: string | undefined, accountToken?: string) {
    const account = await this.account(accountToken);
    if (account) {
      if (account.kind !== 'registered') return null;
      const pending = await this.store.pendingRegistration(account.id);
      return pending ? this.verification.describe(pending) : null;
    }
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    try {
      const user = await this.store.findSession(tokenDigest(token));
      return user ? await this.verification.describe(user) : null;
    } catch {
      throw new RegistrationError('registration_unavailable', 503);
    }
  }
}
