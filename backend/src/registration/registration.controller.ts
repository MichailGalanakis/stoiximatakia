import { VerificationService } from './verification.service';
import { ChannelDto, VerifyCodeDto } from './verification.dto';
import {
  Body,
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ACCOUNT_SESSION_SECONDS,
  readCookie,
  sessionCookie,
} from './account-session';
import { LoginDto } from './login.dto';
import { ProfileDetailsDto } from './profile.dto';
import { RegisterDto } from './register.dto';
import { RegistrationError } from './registration-error';
import { RegistrationService } from './registration.service';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
  SESSION_SECONDS,
  TERMS_VERSION,
} from './registration-settings';

@Controller('auth')
export class RegistrationController {
  constructor(
    @Inject(RegistrationService) private readonly service: RegistrationService,
    @Inject(VerificationService)
    private readonly verification: VerificationService,
    @Inject(REGISTRATION_SETTINGS)
    private readonly settings: RegistrationSettings,
  ) {}

  private get cookieName(): string {
    return this.settings.secureCookie
      ? '__Host-sb_registration'
      : 'sb_registration';
  }

  private get accountCookieName() {
    return this.settings.secureCookie ? '__Host-sb_session' : 'sb_session';
  }
  private accountToken(request: FastifyRequest) {
    return readCookie(request, this.accountCookieName);
  }
  private requireOrigin(request: FastifyRequest) {
    if (
      request.headers.origin !== this.settings.appOrigin ||
      request.headers['x-skillbetting-client'] !== 'web-v1'
    )
      throw new RegistrationError('origin_rejected', 403);
  }
  private emptyBody(input: unknown) {
    if (
      input !== undefined &&
      (!input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length)
    )
      throw new BadRequestException();
  }
  @Get('session')
  async session(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    return { account: await this.service.account(this.accountToken(request)) };
  }
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() input: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    this.requireOrigin(request);
    const { account, token } = await this.service.login(
      input,
      request.ip,
      this.accountToken(request),
    );
    reply.header('set-cookie', [
      sessionCookie(
        this.accountCookieName,
        token,
        this.settings.secureCookie,
        ACCOUNT_SESSION_SECONDS,
      ),
      sessionCookie(this.cookieName, '', this.settings.secureCookie, 0),
    ]);
    return { account };
  }
  @Post('registration/dismiss')
  @HttpCode(200)
  async dismiss(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    this.requireOrigin(request);
    this.emptyBody(input);
    await this.service.dismissRegistration(this.accountToken(request));
    reply.header(
      'set-cookie',
      sessionCookie(this.cookieName, '', this.settings.secureCookie, 0),
    );
    return { dismissed: true };
  }
  @Get('profile')
  async profile(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    return this.service.profile(this.accountToken(request));
  }
  @Post('profile')
  @HttpCode(200)
  async saveProfile(
    @Body() details: ProfileDetailsDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    this.requireOrigin(request);
    return this.service.profile(this.accountToken(request), details);
  }
  @Post('session')
  @HttpCode(200)
  async resumeSignIn(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    this.requireOrigin(request);
    this.emptyBody(input);
    const { account, token } = await this.service.resumeSignIn(
      this.token(request),
      this.accountToken(request),
    );
    if (token)
      reply.header(
        'set-cookie',
        sessionCookie(
          this.accountCookieName,
          token,
          this.settings.secureCookie,
          ACCOUNT_SESSION_SECONDS,
        ),
      );
    return { account };
  }
  @Post('demo')
  @HttpCode(200)
  async demo(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    this.requireOrigin(request);
    this.emptyBody(input);
    const { account, token } = await this.service.demo(
      request.ip,
      this.accountToken(request),
    );
    if (token)
      reply.header('set-cookie', [
        sessionCookie(
          this.accountCookieName,
          token,
          this.settings.secureCookie,
          ACCOUNT_SESSION_SECONDS,
        ),
        sessionCookie(this.cookieName, '', this.settings.secureCookie, 0),
      ]);
    return { account };
  }
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    this.requireOrigin(request);
    this.emptyBody(input);
    await this.service.logout(this.accountToken(request), this.token(request));
    reply.header('set-cookie', [
      sessionCookie(this.accountCookieName, '', this.settings.secureCookie, 0),
      sessionCookie(this.cookieName, '', this.settings.secureCookie, 0),
    ]);
    return { account: null };
  }

  @Post('registrations')
  async register(
    @Body() input: RegisterDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    if (
      request.headers.origin !== this.settings.appOrigin ||
      request.headers['x-skillbetting-client'] !== 'web-v1'
    )
      throw new RegistrationError('origin_rejected', 403);
    const { registration, token, accountToken, account } =
      await this.service.register(
        input,
        request.ip,
        this.accountToken(request),
      );
    reply.header('set-cookie', [
      sessionCookie(
        this.cookieName,
        token,
        this.settings.secureCookie,
        SESSION_SECONDS,
      ),
      sessionCookie(
        this.accountCookieName,
        accountToken,
        this.settings.secureCookie,
        ACCOUNT_SESSION_SECONDS,
      ),
    ]);
    return { registration, account, termsVersion: TERMS_VERSION };
  }

  @Get('registration')
  async resume(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    const token = this.token(request);
    return {
      registration: await this.service.resume(
        token,
        this.accountToken(request),
      ),
      termsVersion: TERMS_VERSION,
    };
  }
  private token(request: FastifyRequest): string | undefined {
    return request.headers.cookie
      ?.split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1);
  }
  private async pending(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    if (
      request.headers.origin !== this.settings.appOrigin ||
      request.headers['x-skillbetting-client'] !== 'web-v1'
    )
      throw new RegistrationError('origin_rejected', 403);
    const user = await this.service.resume(
      this.token(request),
      this.accountToken(request),
    );
    if (!user) throw new RegistrationError('registration_session_expired', 401);
    return user.id;
  }
  @Post('registration/codes')
  @HttpCode(200)
  async initialize(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const id = await this.pending(request, reply);
    return {
      registration: await this.verification.initialize(id),
      termsVersion: TERMS_VERSION,
    };
  }
  @Post('registration/codes/:channel/send')
  @HttpCode(200)
  async resend(
    @Param() params: ChannelDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const id = await this.pending(request, reply);
    await this.verification.send(id, params.channel);
    return {
      registration: await this.verification.current(id),
      termsVersion: TERMS_VERSION,
    };
  }
  @Post('registration/codes/:channel/verify')
  @HttpCode(200)
  async verify(
    @Param() params: ChannelDto,
    @Body() input: VerifyCodeDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const id = await this.pending(request, reply);
    return {
      registration: await this.verification.verify(
        id,
        params.channel,
        input.code,
      ),
      termsVersion: TERMS_VERSION,
    };
  }
}
