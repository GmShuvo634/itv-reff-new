import { authenticateAdmin, checkAccountLockout } from "@/lib/api/auth";
import { db } from "@/lib/db";
import { RATE_LIMITS, rateLimiter } from "@/lib/rate-limiter";
import { addAPISecurityHeaders } from "@/lib/security-headers";
import { SecureTokenManager } from "@/lib/token-manager";
import { NextRequest, NextResponse } from "next/server";
import z from "zod";

const adminLoginSchema = z.object({
  email: z.email("Invalid Email Address").max(255),
  password: z.string().min(1, "Password is required").max(128),
  rememberMe: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  let response: NextResponse = NextResponse.json(
    {
      success: false,
      error: "Internal server error",
    },
    {
      status: 500,
    },
  );

  try {
    const rateLimit = rateLimiter.checkRateLimit(request, RATE_LIMITS.LOGIN);

    if (!rateLimit.allowed) {
      response = NextResponse.json(
        {
          success: false,
          error: rateLimit.blocked
            ? "Too many failed attempts. Account temporarily blocked."
            : "Too many requests. Please try again later",

          retryAfter: Math.ceil((rateLimit.resetTime - Date.now()) / 1000),
        },
        {
          status: 429,
        },
      );
      return addAPISecurityHeaders(response);
    }

    const body = await request.json();
    const validatedData = adminLoginSchema.parse(body);

    const lockoutStatus = await checkAccountLockout(validatedData.email);
    if (lockoutStatus.locked) {
      response = NextResponse.json(
        {
          success: false,
          error:
            "Account is temporarily locked due to too many failed attempts",
          lockoutUntil: lockoutStatus.lockoutUntil,
        },
        { status: 423 },
      );
      return addAPISecurityHeaders(response);
    }

    const ipAddress =
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "unknown";

    const admin = await authenticateAdmin(
      validatedData.email,
      validatedData.password,
    );

    if (!admin) {
      response = NextResponse.json(
        {
          success: false,
          error: "Invalid email or password",
          remainingAttempts: Math.max(0, 5 - (lockoutStatus.attempts + 1)),
        },
        {
          status: 401,
        },
      );
      return addAPISecurityHeaders(response);
    }

    const tokens = SecureTokenManager.generateTokenPair(admin.id, admin.email);

    rateLimiter.recordSuccess(request);

    response = NextResponse.json({
      success: true,
      message: "Login Successfully",
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
      },
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      },
    });

    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict" as const,
      path: "/",
    };

    response.cookies.set("access_token", tokens.accessToken, {
      ...cookieOptions,
      maxAge: 15 * 60, // 15 minutes
    });

    // Set refresh token (longer-lived) - keep for API route usage
    response.cookies.set("refresh-token", tokens.refreshToken, {
      ...cookieOptions,
      maxAge: validatedData.rememberMe ? 7 * 24 * 60 * 60 : 24 * 60 * 60, // 7 days or 1 day
    });

    return addAPISecurityHeaders(response);
  } catch (error) {
    console.error("Login error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
