import { Request, Response, NextFunction } from "express";
import { body, query, validationResult } from "express-validator";
import sanitizeHtml from "sanitize-html";
import { errorCode } from "../../../config/errorCode";
import { createError } from "../../utils/error";
import { getUserById } from "../../services/authService";
import { checkUserIfNotExist } from "../../utils/auth";
import { checkModelIfExist, checkUploadFile } from "../../utils/check";
import ImageQueue from "../../jobs/queues/imageQueue";
import {
  createOnePost,
  deleteOnePost,
  getPostById,
  PostArgs,
  updateOnePost,
} from "../../services/postService";
import path from "path";
import { unlink } from "fs/promises";
import { cache } from "sharp";
import cacheQueue from "../../jobs/queues/cacheQueue";

interface CustomRequest extends Request {
  userId?: number;
  user?: any;
}

const removeFiles = async (
  originalFile: string,
  optimizedFile?: string | null
) => {
  try {
    const originalFilePath = path.join(
      __dirname,
      "../../../",
      "/uploads/images",
      originalFile
    );

    await unlink(originalFilePath);

    if (optimizedFile) {
      const optimizedFilePath = path.join(
        __dirname,
        "../../../",
        "/uploads/optimize",
        originalFile
      );
      await unlink(optimizedFilePath);
    }
  } catch (error) {
    console.log("Error deleting file: ", error);
  }
};

export const createPost = [
  body("title", "Title is required").trim().notEmpty().escape(),
  body("content", "Content is required").trim().notEmpty().escape(),
  body("body", "Body is required")
    .trim()
    .notEmpty()
    .customSanitizer((value) => sanitizeHtml(value))
    .notEmpty(),
  body("category", "Category is required").trim().notEmpty().escape(),
  body("type", "Type is required").trim().notEmpty().escape(),
  body("tags", "Tag is invalid")
    .optional({ nullable: true })
    .customSanitizer((value) => {
      if (value) {
        return value.split(",").filter((tag: string) => tag.trim() !== "");
      }
      return value;
    }),

  async (req: CustomRequest, res: Response, next: NextFunction) => {
    const errors = validationResult(req).array({ onlyFirstError: true });
    if (errors.length > 0) {
      if (req.file) {
        await removeFiles(req.file.filename, null);
      }
      return next(createError(errors[0].msg, 400, errorCode.invalid));
    }
    const { title, content, body, category, type, tags } = req.body;
    const user = req.user;
   
    checkUploadFile(req.file);

    const splitFileName = req.file?.filename.split(".")[0];

    await ImageQueue.add(
      "optimize-image",
      {
        filePath: req.file?.path,
        fileName: `${splitFileName}.webp`,
        width: 835,
        height: 577,
        quality: 100,
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
      }
    );
    const data: PostArgs = {
      title,
      content,
      body,
      image: req.file!.filename,
      authorId: user!.id,
      category,
      type,
      tags,
    };
    const post = await createOnePost(data);

    await cacheQueue.add("invalidate-post-cache", {
      pattern: "posts:*",
    }, {
      jobId: `invalidate-${Date.now()}`,
      priority: 1,


    });

    res
      .status(201)
      .json({ message: "Successfully created new post.", postId: post.id });
  },
];

export const updatePost = [
  body("postId", "Post Id is required").trim().notEmpty().isInt({ min: 1 }),
  body("title", "Title is required").trim().notEmpty().escape(),
  body("content", "Content is required").trim().notEmpty().escape(),
  body("body", "Body is required")
    .trim()
    .notEmpty()
    .customSanitizer((value) => sanitizeHtml(value))
    .notEmpty(),
  body("category", "Category is required").trim().notEmpty().escape(),
  body("type", "Type is required").trim().notEmpty().escape(),
  body("tags", "Tag is invalid")
    .optional({ nullable: true })
    .customSanitizer((value) => {
      if (value) {
        return value.split(",").filter((tag: string) => tag.trim() !== "");
      }
      return value;
    }),

  async (req: CustomRequest, res: Response, next: NextFunction) => {
    const errors = validationResult(req).array({ onlyFirstError: true });
    if (errors.length > 0) {
      if (req.file) {
        await removeFiles(req.file.filename, null);
      }
      return next(createError(errors[0].msg, 400, errorCode.invalid));
    }
    const { postId, title, content, body, category, type, tags } = req.body;

    const user = req.user;

    const post = await getPostById(+postId); //"8" -> 8
    if (!post) {
      if (req.file) {
        await removeFiles(req.file.filename, null);
      }
      return next(
        createError("This data does not exist.", 404, errorCode.invalid)
      );
    }
    if (user.id !== post.authorId) {
      if (req.file) {
        await removeFiles(req.file.filename, null);
      }
      return next(
        createError(
          "You are not allowed to update this post.",
          403,
          errorCode.unauthorized
        )
      );
    }

    let data: any = {
      title,
      content,
      body,
      image: req.file,
      category,
      type,
      tags,
    };

    if (req.file) {
      data.image = req.file.filename;

      const splitFileName = req.file.filename.split(".")[0];

      await ImageQueue.add(
        "optimize-image",
        {
          filePath: req.file.path,
          fileName: `${splitFileName}.webp`,
          width: 835,
          height: 577,
          quality: 100,
        },
        {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
        }
      );
      const optimizedFile = post.image.split(".")[0] + ".webp";
      await removeFiles(post.image, optimizedFile);
    }

    const postUpdated = await updateOnePost(post.id, data);
     await cacheQueue.add("invalidate-post-cache", {
      pattern: "posts:*",
    }, {
      jobId: `invalidate-${Date.now()}`,
      priority: 1,
      

    });

    res.status(200).json({ message: "Successfully updated post.", postId: postUpdated.id });
  },
];

export const deletePost = [
  body("postId", "Post Id is required").isInt({ gt: 0 }),
  
  async (req: CustomRequest, res: Response, next: NextFunction) => {
    const errors = validationResult(req).array({ onlyFirstError: true });
    if (errors.length > 0) {
      return next(createError(errors[0].msg, 400, errorCode.invalid));
    }
    const { postId } = req.body;
    const user = req.user;

    const post = await getPostById(+postId); //"8" -> 8
    checkModelIfExist(post);

    if (user!.id !== post!.authorId) {
      return next(
        createError(
          "You are not allowed to delete this post.",
          403,
          errorCode.unauthorized
        )
      );
    }

    const postDeleted = await deleteOnePost(post!.id);
    console.log("postDeleted: ", post?.image);
    const optimizedFile = post!.image.split(".")[0] + ".webp";
    console.log("optimizedFile: ", optimizedFile);
    await removeFiles(post!.image, optimizedFile);

     await cacheQueue.add("invalidate-post-cache", {
      pattern: "posts:*",
    }, {
      jobId: `invalidate-${Date.now()}`,
      priority: 1,
      

    });

    res
      .status(200)
      .json({ message: "Post deleted successfully.", postId: postDeleted.id });
  },
];
