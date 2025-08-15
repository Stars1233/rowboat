import { z } from "zod";
import { ObjectId } from "mongodb";
import { usersCollection } from "./mongodb";
import { auth0 } from "./auth0";
import { User, WithStringId } from "./types/types";
import { USE_AUTH } from "./feature_flags";
import { redirect } from "next/navigation";

export const GUEST_SESSION = {
    email: "guest@rowboatlabs.com",
    email_verified: true,
    sub: "guest_user",
}

export const GUEST_DB_USER: WithStringId<z.infer<typeof User>> = {
    _id: "guest_user",
    auth0Id: "guest_user",
    name: "Guest",
    email: "guest@rowboatlabs.com",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
}

/**
 * This function should be used as an initial check in server page components to ensure
 * the user is authenticated. It will:
 * 1. Check for a valid user session
 * 2. Redirect to login if no session exists
 * 3. Return the authenticated user
 *
 * Usage in server components:
 * ```ts
 * const user = await requireAuth();
 * ```
 */
export async function requireAuth(): Promise<WithStringId<z.infer<typeof User>>> {
    if (!USE_AUTH) {
        return GUEST_DB_USER;
    }

    const { user } = await auth0.getSession() || {};
    if (!user) {
        redirect('/auth/login');
    }

    // fetch db user
    let dbUser = await getUserFromSessionId(user.sub);

    // if db user does not exist, create one
    if (!dbUser) {
        // create user record
        const doc = {
            _id: new ObjectId(),
            auth0Id: user.sub,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            email: user.email,
        };
        console.log(`creating new user id ${doc._id.toString()} for session id ${user.sub}`);
        await usersCollection.insertOne(doc);

        dbUser = {
            ...doc,
            _id: doc._id.toString(),
        };
    }

    const { _id, ...rest } = dbUser;
    return {
        ...rest,
        _id: _id.toString(),
    };
}

export async function getUserFromSessionId(sessionUserId: string): Promise<WithStringId<z.infer<typeof User>> | null> {
    if (!USE_AUTH) {
        return GUEST_DB_USER;
    }

    let dbUser = await usersCollection.findOne({
        auth0Id: sessionUserId
    });
    if (!dbUser) {
        return null;
    }
    const { _id, ...rest } = dbUser;
    return {
        ...rest,
        _id: _id.toString(),
    };
}