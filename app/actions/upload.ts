"use server";

import Replicate from "replicate";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { nanoid } from "nanoid";
import { getDomain } from "@/lib/utils";
import { Tables } from "@/lib/supabase/types_db";
import { UserData } from "@/lib/types";
// import { waitUntil } from "@vercel/functions";

export type UploadState = {
  message: string;
  status: number;
  redirectUrl?: string | null;
  updatedUser?: Tables<"users"> | null;
};

export async function upload(previousState: UploadState, formData: FormData): Promise<UploadState> {
  const replicate = new Replicate({
    // get your token from https://replicate.com/account
    auth: process.env.REPLICATE_API_TOKEN || "",
  });

  // Authenticate
  const cookieStore = cookies();
  const supabase = createClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const user_id = user?.id;
  if (!user_id) return { message: "Please sign in to continue", status: 401 };

  // Check credits
  const credits = await getCredits(user_id);
  if (!credits || credits < 10)
    return { message: "Not enough credits, please buy more", status: 402 };

  const supabaseAdmin = createAdminClient();

  const image = formData.get("image") as File;
  if (!image) {
    return { message: "Missing image", status: 400 };
  }

  // Handle request
  // Generate key and insert id to supabase
  const { key } = await setRandomKey(user_id);
  const input = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/input/${user_id}/${key}`;
  const buffer = await image.arrayBuffer();

  console.log("开始上传...", new Date().toISOString());

  const { data: storageData, error: storageError } = await supabaseAdmin.storage
    .from("input")
    .upload(`/${user_id}/${key}`, buffer, {
      contentType: image.type,
      cacheControl: "3600",
      upsert: true,
    });

  if (storageError) {
    console.log("Error uploading image", storageError);
    return {
      message: "Unexpected error uploading image, please try again",
      status: 400,
    };
  } else {
    console.log("上传成功，开始预测分析...", new Date().toISOString());
  }

  try {
    const prediction = await replicate.predictions.create({
      version:
        "9222a21c181b707209ef12b5e0d7e94c994b58f01c7b2fec075d2e892362f13c",
      input: {
        image: input,
        target_age: "default",
      },
      webhook: getDomain(`/api/webhooks/replicate/${key}`),
      webhook_events_filter: ["completed"],
    });

    if (
      prediction.error ||
      prediction.status === "failed" ||
      prediction.status === "canceled"
    ) {
      return { 
        message: "Prediction error generating gif", 
        status: 500
      };
    }

    // 以下87-93行是修改后的处理逻辑
    const updatedUserData = await updateCredits(user_id, -10);
    return {
      message: "",
      status: 200,
      redirectUrl: `/p/${key}`,
      updatedUser: updatedUserData // 包含最新积分数据
    };

  } catch (e) {
    console.log("Error generating gif", e);
    return {
      message: "Unexpected error generating gif, please try again",
      status: 500
    };
  }

  // 以下是原来的处理逻辑
  // await updateCredits(user_id, -10);
  // redirect(`/p/${key}`);
}

// Generates new key that doesn't already exist in db
async function setRandomKey(user_id: string): Promise<{ key: string }> {
  const cookieStore = cookies();
  const supabase = createClient(cookieStore);

  /* recursively set link till successful */
  const key = nanoid();
  const { error } = await supabase.from("data").insert({
    id: key,
    input: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/input/${user_id}/${key}`,
  });
  if (error) {
    // by the off chance that key already exists
    return setRandomKey(user_id);
  } else {
    return { key };
  }
}

async function getCredits(user_id: string) {
  const supabaseAdmin = createAdminClient();

  const { data } = await supabaseAdmin
    .from("users")
    .select("credits")
    .eq("id", user_id)
    .single();
  return data?.credits;
}

async function updateCredits(
  user_id: string,
  credit_amount: number
): Promise<UserData> {
  const supabaseAdmin = createAdminClient();

  // 1. 执行 RPC 更新积分
  const { error: rpcError } = await supabaseAdmin.rpc("update_credits", {
    user_id,
    credit_amount,
  });

  if (rpcError) {
    console.error("RPC 调用失败:", rpcError);
    throw new Error("积分更新失败");
  }

  // 2. 查询最新用户数据
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", user_id)
    .single();

  if (error) {
    console.error("查询用户数据失败:", error);
    throw new Error("用户数据获取失败");
  }

  return data;
}

// async function updateCredits(user_id: string, credit_amount: number) {
//   const supabaseAdmin = createAdminClient();

//   await supabaseAdmin.rpc("update_credits", {
//     user_id: user_id,
//     credit_amount: credit_amount,
//   });
// }
