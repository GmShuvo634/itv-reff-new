import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();

    if (
      !session?.user?.role ||
      !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)
    ) {
      return NextResponse.json(
        { success: false, error: "Unauthorized access" },
        { status: 401 },
      );
    }

    // Get USDT to PKR rate
    const usdtRateSetting = await prisma.setting.findUnique({
      where: { key: "usdt_to_pkr_rate" },
    });

    // Get USDT wallet info
    const usdtWallet = await prisma.adminWallet.findFirst({
      where: { walletType: "USDT_TRC20" as any, isActive: true },
      include: {
        _count: {
          select: {
            topupRequests: true,
          },
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        usdtToPkrRate: usdtRateSetting
          ? parseFloat(usdtRateSetting.value)
          : 295,
        lastUpdated: usdtRateSetting?.updatedAt || null,
        usdtWallet,
        bonusPercentage: 3, // Fixed 3% bonus
      },
    });
  } catch (error) {
    console.error("Error fetching USDT settings:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getAdminSession();

    if (
      !session?.user?.role ||
      !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)
    ) {
      return NextResponse.json(
        { success: false, error: "Unauthorized access" },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { usdtToPkrRate, walletHolderName, usdtWalletAddress, qrCodeUrl } =
      body;

    // Validate USDT rate
    if (
      usdtToPkrRate &&
      (typeof usdtToPkrRate !== "number" || usdtToPkrRate <= 0)
    ) {
      return NextResponse.json(
        { success: false, error: "Invalid USDT to PKR rate" },
        { status: 400 },
      );
    }

    // Update USDT rate if provided
    if (usdtToPkrRate) {
      await prisma.setting.upsert({
        where: { key: "usdt_to_pkr_rate" },
        update: {
          value: usdtToPkrRate.toString(),
          updatedAt: new Date(),
        },
        create: {
          key: "usdt_to_pkr_rate",
          value: usdtToPkrRate.toString(),
        },
      });
    }

    // Update or create USDT wallet if wallet info provided
    let usdtWallet: any = null;
    if (walletHolderName || usdtWalletAddress || qrCodeUrl !== undefined) {
      // Check if USDT wallet exists
      const existingUsdtWallet = await prisma.adminWallet.findFirst({
        where: { walletType: "USDT_TRC20" as any },
      });

      if (existingUsdtWallet) {
        // Update existing wallet
        const updateData: any = {};
        if (walletHolderName) updateData.walletHolderName = walletHolderName;
        if (usdtWalletAddress) updateData.usdtWalletAddress = usdtWalletAddress;
        if (qrCodeUrl !== undefined) updateData.qrCodeUrl = qrCodeUrl || null;

        usdtWallet = await prisma.adminWallet.update({
          where: { id: existingUsdtWallet.id },
          data: updateData,
          include: {
            _count: {
              select: {
                topupRequests: true,
              },
            },
          },
        });
      } else if (walletHolderName && usdtWalletAddress) {
        // Create new USDT wallet
        const createData: any = {
          walletType: "USDT_TRC20" as any,
          walletHolderName,
          usdtWalletAddress,
          qrCodeUrl: qrCodeUrl || null,
          walletNumber: null, // USDT doesn't use phone number
        };

        usdtWallet = await prisma.adminWallet.create({
          data: createData,
          include: {
            _count: {
              select: {
                topupRequests: true,
              },
            },
          },
        });
      }
    }

    // Create audit log
    try {
      await prisma.auditLog.create({
        data: {
          adminId: session.user.id,
          action: "BULK_UPDATE",
          targetType: "usdt_settings",
          targetId: "usdt_settings",
          description: "Updated USDT settings",
          details: JSON.stringify({
            usdtToPkrRate,
            walletUpdated: !!usdtWallet,
            walletId: usdtWallet ? usdtWallet.id : null,
          }),
        },
      });
    } catch (auditError) {
      console.error("Failed to create audit log:", auditError);
    }

    return NextResponse.json({
      success: true,
      message: "USDT settings updated successfully",
      data: {
        usdtToPkrRate,
        usdtWallet,
      },
    });
  } catch (error) {
    console.error("Error updating USDT settings:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
