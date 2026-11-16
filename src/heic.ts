import { heicTo } from "heic-to/csp";

export async function convertHeicToJpeg(image: File): Promise<File> {
	const blob = await heicTo({ blob: image, type: "image/jpeg", quality: 0.9 });
	if (blob.type !== "image/jpeg" || blob.size === 0) {
		throw new Error("The converter did not produce a JPEG image.");
	}
	const name = image.name.replace(/\.(heic|heif)$/i, "") || "pasted";
	return new File([blob], `${name}.jpg`, {
		type: "image/jpeg",
		lastModified: image.lastModified,
	});
}
