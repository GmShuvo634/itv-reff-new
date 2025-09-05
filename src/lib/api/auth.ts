import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { AdminUser, User } from "@prisma/client";
import {
  SecureTokenManager,
  TokenPair,
  generateToken,
  verifyToken,
} from "@/lib/token-manager";

const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 30 * 60 * 1000; // 30 minutes

export interface JWTPayload {
  userId: string;
  email: string;
}

export interface AuthResult {
  success: boolean;
  user?: Partial<User>;
  tokens?: TokenPair;
  error?: string;
  remainingAttempts?: number;
  lockoutUntil?: Date;
}

// Password security functions
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hashedPassword: string,
): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

export function validatePasswordStrength(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push("Password must be at least 8 characters long");
  }

  if (!/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter");
  }

  if (!/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter");
  }

  if (!/\d/.test(password)) {
    errors.push("Password must contain at least one number");
  }

  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push("Password must contain at least one special character");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Account lockout functions
export async function checkAccountLockout(
  email: string,
): Promise<{ locked: boolean; lockoutUntil?: Date; attempts: number }> {
  const user = await db.user.findUnique({
    where: { email },
    select: {
      failedLoginAttempts: true,
      lastFailedLogin: true,
      lockedUntil: true,
    },
  });

  if (!user) {
    return { locked: false, attempts: 0 };
  }

  const now = new Date();

  // Check if account is currently locked
  if (user.lockedUntil && user.lockedUntil > now) {
    return {
      locked: true,
      lockoutUntil: user.lockedUntil,
      attempts: user.failedLoginAttempts || 0,
    };
  }

  return {
    locked: false,
    attempts: user.failedLoginAttempts || 0,
  };
}

export async function recordFailedLogin(email: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, failedLoginAttempts: true },
  });

  if (!user) return;

  const attempts = (user.failedLoginAttempts || 0) + 1;
  const now = new Date();

  const updateData: any = {
    failedLoginAttempts: attempts,
    lastFailedLogin: now,
  };

  // Lock account if max attempts reached
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    updateData.lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION);
  }

  await db.user.update({
    where: { id: user.id },
    data: updateData,
  });
}

export async function resetFailedLogins(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: 0,
      lastFailedLogin: null,
      lockedUntil: null,
    },
  });
}

export async function authenticateUser(
  email: string,
  password: string,
): Promise<User | null> {
  try {
    const user = await db.user.findUnique({
      where: { email },
    });

    if (!user || !user.password) {
      return null;
    }

    const isValidPassword = await verifyPassword(password, user.password);
    if (!isValidPassword) {
      return null;
    }

    return user;
  } catch (error) {
    console.error("Authentication error:", error);
    return null;
  }
}

export async function authenticateAdmin(
  email: string,
  password: string,
): Promise<AdminUser | null> {
  try {
    const admin = await db.adminUser.findUnique({
      where: { email },
    });

    if (!admin || !admin.password) {
      return null;
    }

    const isValidPassword = await verifyPassword(password, admin.password);
    if (!isValidPassword) {
      return null;
    }

    return admin;
  } catch (error) {
    console.error("Authentication error:", error);
    return null;
  }
}

export async function createUser(userData: {
  email: string;
  name?: string;
  phone?: string;
  password: string;
  referralCode?: string;
}): Promise<User | null> {
  try {
    const hashedPassword = await hashPassword(userData.password);

    // Generate unique referral code
    const referralCode = generateReferralCode();

    // Check if user was referred by someone
    let referredBy: string | null = null;
    if (userData.referralCode) {
      const referrer = await db.user.findUnique({
        where: { referralCode: userData.referralCode },
      });
      if (referrer) {
        referredBy = referrer.id;
      }
    }

    // Get the Intern position for new users
    const internPosition = await db.positionLevel.findUnique({
      where: { name: "Intern" },
    });

    if (!internPosition) {
      throw new Error(
        "Intern position not found. Please ensure position levels are seeded.",
      );
    }

    // Calculate position validity dates
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + internPosition.validityDays);

    const user = await db.user.create({
      data: {
        email: userData.email,
        name: userData.name,
        phone: userData.phone || null,
        password: hashedPassword,
        referralCode,
        referredBy,
        ipAddress: "", // Will be set from request
        deviceId: "", // Will be set from request
        // Assign Intern position to new users
        currentPositionId: internPosition.id,
        positionStartDate: startDate,
        positionEndDate: endDate,
        isIntern: true,
        depositPaid: 0,
      },
    });

    return user;
  } catch (error) {
    console.error("User creation error:", error);
    // Re-throw the error so it can be properly handled by the calling function
    throw error;
  }
}

function generateReferralCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export type AuthUser = Pick<
  User,
  | "id"
  | "email"
  | "name"
  | "phone"
  | "password"
  | "emailVerified"
  | "phoneVerified"
  | "referralCode"
  | "referredBy"
  | "status"
  | "ipAddress"
  | "deviceId"
  | "walletBalance"
  | "totalEarnings"
  | "createdAt"
  | "updatedAt"
>;
export async function getUserById(id: string): Promise<AuthUser | null> {
  try {
    return await db.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        password: true,
        emailVerified: true,
        phoneVerified: true,
        referralCode: true,
        referredBy: true,
        status: true,
        ipAddress: true,
        deviceId: true,
        walletBalance: true,
        totalEarnings: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch (error) {
    console.error("Get user error:", error);
    return null;
  }
}

export type AuthAdmin = Pick<AdminUser, "id" | "name" | "email" | "role">;

export async function getAdminById(id: string): Promise<AuthAdmin | null> {
  try {
    return await db.adminUser.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });
  } catch (error) {
    console.error("Get admin error:", error);
    return null;
  }
}

// Server-side user fetching for SSR authentication
export async function getUserFromServer() {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const token = cookieStore.get("access_token")?.value;

  if (!token) return null;

  try {
    const res = await fetch(`${process.env.BACKEND_URL}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Cookie: `access_token=${token}`,
      },
      cache: "no-store",
    });

    if (!res.ok) return null;

    const data = await res.json();
    return data.success ? data.user : null;
  } catch (error) {
    console.error("getUserFromServer error:", error);
    return null;
  }
}

export async function getAdminFromServer() {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const token = cookieStore.get("access_token")?.value;

  if (!token) {
    console.log("getAdminFromServer: No access token found");
    return null;
  }

  try {
    // Direct database lookup instead of API call to avoid fetch issues
    const payload = SecureTokenManager.verifyAccessToken(token);
    if (!payload) {
      console.log("getAdminFromServer: Invalid token");
      return null;
    }

    // Get admin directly from database
    const admin = await getAdminById(payload.userId);

    if (!admin) {
      console.log(
        "getAdminFromServer: Admin not found for userId:",
        payload.userId,
      );
      return null;
    }

    console.log("getAdminFromServer: Admin retrieved successfully", admin);
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    };
  } catch (error) {
    console.error("getAdminFromServer error:", error);
    return null;
  }
}

// Helper function to validate redirect paths (prevent open redirect attacks)
function validateRedirectPath(path: string): string {
  // Default safe path
  const defaultPath = "/dashboard";

  if (!path || typeof path !== "string") {
    return defaultPath;
  }

  // Remove any whitespace
  path = path.trim();

  // Must start with "/" and not be a protocol-relative URL
  if (!path.startsWith("/") || path.startsWith("//")) {
    return defaultPath;
  }

  // Reject absolute URLs with protocols
  if (
    path.includes("://") ||
    path.startsWith("http") ||
    path.startsWith("ftp")
  ) {
    return defaultPath;
  }

  // Additional safety checks
  if (path.includes("..") || path.includes("\\")) {
    return defaultPath;
  }

  return path;
}

// Helper function to extract and set authentication cookies
async function setAuthCookiesFromResponse(
  response: Response,
  rememberMe: boolean = false,
) {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();

  // Try to extract access_token from Set-Cookie header
  const setCookieHeader = response.headers.get("set-cookie");
  let accessToken: string | null = null;

  if (setCookieHeader) {
    // Parse Set-Cookie header for access_token
    const accessTokenMatch = setCookieHeader.match(/access_token=([^;]+)/);
    if (accessTokenMatch) {
      accessToken = accessTokenMatch[1];
    }
  }

  // If not found in headers, try response body
  if (!accessToken) {
    try {
      const data = await response.clone().json();
      if (data.tokens?.accessToken) {
        accessToken = data.tokens.accessToken;
      }
    } catch (e) {
      // Response body might not be JSON or already consumed
    }
  }

  if (accessToken) {
    // Set secure cookie options
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict" as const,
      path: "/",
    };

    // Set access token with appropriate expiration
    cookieStore.set("access_token", accessToken, {
      ...cookieOptions,
      maxAge: rememberMe ? 7 * 24 * 60 * 60 : 15 * 60, // 7 days or 15 minutes
    });

    return true;
  }

  return false;
}

// Server action for login with redirect-after-login functionality
export async function loginAction(prevState: any, formData: FormData) {
  "use server";

  const { cookies } = await import("next/headers");
  const { redirect } = await import("next/navigation");

  // Validate environment configuration
  if (!process.env.BACKEND_URL) {
    return {
      error: "Server configuration error. Please try again later.",
    };
  }

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const rememberMe = formData.get("rememberMe") === "on";

  try {
    const response = await fetch(`${process.env.BACKEND_URL}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, rememberMe }),
    });

    const data = await response.json();

    if (response.ok && data.success) {
      // Set authentication cookies in the browser
      const cookiesSet = await setAuthCookiesFromResponse(response, rememberMe);

      if (!cookiesSet) {
        // Fallback: manually set cookie if extraction failed
        const cookieStore = await cookies();
        if (data.tokens?.accessToken) {
          cookieStore.set("access_token", data.tokens.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            path: "/",
            maxAge: rememberMe ? 7 * 24 * 60 * 60 : 15 * 60,
          });
        }
      }

      // Get and validate redirect path
      const cookieStore = await cookies();
      const rawRedirectPath = cookieStore.get("redirect_after_login")?.value;
      const redirectPath = validateRedirectPath(
        rawRedirectPath || "/dashboard",
      );

      // Clear redirect cookie
      cookieStore.delete("redirect_after_login");

      redirect(redirectPath);
    } else {
      // Return error state for client-side handling
      return {
        error: data.error || "Login failed",
      };
    }
  } catch (error: any) {
    // Check if this is a Next.js redirect (expected behavior)
    if (
      error?.message === "NEXT_REDIRECT" ||
      error?.digest?.startsWith("NEXT_REDIRECT")
    ) {
      // This is expected behavior for redirects, re-throw to allow redirect to work
      throw error;
    }

    // Log actual errors only
    console.error("Login action error:", error);
    return {
      error: "Network error. Please try again.",
    };
  }
}

export async function adminLoginAction(prevState: any, formData: FormData) {
  "use server";

  const { cookies } = await import("next/headers");
  const { redirect } = await import("next/navigation");

  if (!process.env.BACKEND_URL) {
    return {
      error: "Server Configuration error. Please try again later.",
    };
  }

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const rememberMe = formData.get("rememberMe") === "on";
  try {
    const response = await fetch(
      `${process.env.BACKEND_URL}/api/auth/admin-login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, rememberMe }),
      },
    );

    const data = await response.json();

    if (response.ok && data.success) {
      const cookiesSet = await setAuthCookiesFromResponse(response, rememberMe);

      if (!cookiesSet) {
        const cookieStore = await cookies();

        if (data.tokens?.accessToken) {
          cookieStore.set("access_token", data.tokens.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            path: "/",
            maxAge: rememberMe ? 7 * 24 * 60 * 60 : 15 * 60,
          });
        }
      }

      const cookieStore = await cookies();
      const rawRedirectPath = cookieStore.get(
        "admin_redirect_after_login",
      )?.value;
      const redirectPath = validateRedirectPath(
        rawRedirectPath || "/admin/analytics",
      );

      cookieStore.delete("admin_redirect_after_login");

      redirect(redirectPath);
    } else {
      return {
        error: data.error || "Login failed",
      };
    }
  } catch (error: any) {
    if (
      error?.message === "NEXT_REDIRECT" ||
      error?.digest?.startsWith("NEXT_REDIRECT")
    ) {
      // This is expected behavior for redirects, re-throw to allow redirect to work
      throw error;
    }

    // Log actual errors only
    console.error("Login action error:", error);
    return {
      error: "Network error. Please try again.",
    };
  }
}

// Server action for registration with redirect functionality
export async function registerAction(prevState: any, formData: FormData) {
  "use server";

  const { redirect } = await import("next/navigation");

  // Validate environment configuration
  if (!process.env.BACKEND_URL) {
    return {
      error: "Server configuration error. Please try again later.",
    };
  }

  const name = formData.get("name") as string;
  const email = formData.get("email") as string;
  const phone = formData.get("phone") as string;
  const password = formData.get("password") as string;
  const confirmPassword = formData.get("confirmPassword") as string;
  const referralCode = formData.get("referralCode") as string;

  // Basic validation
  if (!name || !email || !password) {
    return {
      error: "Please fill in all required fields",
    };
  }

  if (password !== confirmPassword) {
    return {
      error: "Passwords do not match",
    };
  }

  if (password.length < 6) {
    return {
      error: "Password must be at least 6 characters long",
    };
  }

  // Email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return {
      error: "Please enter a valid email address",
    };
  }

  try {
    const response = await fetch(
      `${process.env.BACKEND_URL}/api/auth/register`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          email,
          phone: phone || undefined,
          password,
          confirmPassword,
          referralCode: referralCode || undefined,
        }),
      },
    );

    const data = await response.json();

    if (response.ok && data.success) {
      // Set authentication cookies for automatic login after registration
      const cookiesSet = await setAuthCookiesFromResponse(response, false);

      if (!cookiesSet) {
        // Fallback: manually set cookie if extraction failed
        const { cookies } = await import("next/headers");
        const cookieStore = await cookies();
        if (data.tokens?.accessToken) {
          cookieStore.set("access_token", data.tokens.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            path: "/",
            maxAge: 15 * 60, // 15 minutes for new registrations
          });
        }
      }

      // Redirect to dashboard after successful registration and auto-login
      redirect("/dashboard");
    } else {
      return {
        error: data.error || "Registration failed",
      };
    }
  } catch (error: any) {
    // Check if this is a Next.js redirect (expected behavior)
    if (
      error?.message === "NEXT_REDIRECT" ||
      error?.digest?.startsWith("NEXT_REDIRECT")
    ) {
      throw error;
    }

    console.error("Registration action error:", error);
    return {
      error: "Network error. Please try again.",
    };
  }
}
