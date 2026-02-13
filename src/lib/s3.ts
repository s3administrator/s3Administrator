import { S3Client } from "@aws-sdk/client-s3"
import { prisma } from "@/lib/db"
import { decrypt } from "@/lib/crypto"

export async function getS3Client(
  userId: string,
  credentialId?: string
): Promise<{
  client: S3Client
  credential: {
    id: string
    endpoint: string
    region: string
    provider: string
    label: string
  }
}> {
  const credential = await prisma.s3Credential.findFirst({
    where: credentialId
      ? { id: credentialId, userId }
      : { userId, isDefault: true },
  })

  if (!credential) {
    throw new Error("No S3 credentials configured")
  }

  const accessKey = decrypt(credential.accessKeyEnc, credential.ivAccessKey)
  const secretKey = decrypt(credential.secretKeyEnc, credential.ivSecretKey)

  const client = new S3Client({
    endpoint: credential.endpoint,
    region: credential.region,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true,
  })

  return {
    client,
    credential: {
      id: credential.id,
      endpoint: credential.endpoint,
      region: credential.region,
      provider: credential.provider,
      label: credential.label,
    },
  }
}
