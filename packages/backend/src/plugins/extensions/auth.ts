import {
    AuthService,
    BackendModuleRegistrationPoints,
    coreServices,
    createBackendModule
} from "@backstage/backend-plugin-api";
import {
    authProvidersExtensionPoint, AuthResolverContext, createOAuthProviderFactory,
    createProxyAuthenticator, createProxyAuthProviderFactory
} from "@backstage/plugin-auth-node";
import {OAuth2ProxyResult} from "@backstage/plugin-auth-backend-module-oauth2-proxy-provider";
import {Entity, stringifyEntityRef} from "@backstage/catalog-model";
import {jwtDecode, JwtPayload} from "jwt-decode";
import {CatalogApi, CatalogClient} from "@backstage/catalog-client";
import { AuthenticationError } from '@backstage/errors';
import {getDefaultOwnershipEntityRefs} from "@backstage/plugin-auth-backend";
import { githubAuthenticator } from '@backstage/plugin-auth-backend-module-github-provider';

export const authModuleGithubLocalProvider = createBackendModule({
    pluginId: 'auth',
    moduleId: 'githubLocalProvider',
    register(reg: BackendModuleRegistrationPoints) {
        reg.registerInit({
            deps: {
                providers: authProvidersExtensionPoint,
                discovery: coreServices.discovery,
                auth: coreServices.auth,
            },
            async init({ providers, discovery, auth}) {
                providers.registerProvider({
                    providerId: 'github',
                    factory: createOAuthProviderFactory({
                        authenticator: githubAuthenticator,
                        async signInResolver(info, ctx) {
                            const catalogApi = new CatalogClient({ discoveryApi: discovery })
                            const username = info.result.fullProfile.username
                            if (!username) {
                                throw new AuthenticationError('Authentication failed', "No username found in profile");
                            }
                            const { entity } = await ctx.findCatalogUser({
                                annotations: {
                                    'microsoft.com/email': info.result.fullProfile.username as string,
                                }
                            })
                            if (!entity) {
                                throw new AuthenticationError('Authentication failed', "No user found in catalog");
                            }
                            const ownershipRefs = getDefaultOwnershipEntityRefs(entity)
                            return ctx.issueToken({
                                claims: {
                                    sub: stringifyEntityRef(entity),
                                    ent: ownershipRefs,
                                    groups: await getGroupDisplayNamesForEntity(ownershipRefs, catalogApi, auth)
                                }
                            })
                        }
                    })
                })
            }
        })
    }
})


export const authModuleIstioProvider = createBackendModule({
    pluginId: 'auth',
    moduleId: 'istioProvider',
    register(reg) {
        reg.registerInit({
            deps: {
                providers: authProvidersExtensionPoint,
                discovery: coreServices.discovery,
                auth: coreServices.auth
            },
            async init({ providers, discovery, auth }){
                providers.registerProvider({
                    providerId: 'istio',
                    factory: createProxyAuthProviderFactory({
                       authenticator: istioProxyAuthenticator,
                       signInResolver: async ({ result }, ctx) => {
                           const catalogApi = new CatalogClient({ discoveryApi: discovery })
                           const entity = await getUserFromResult(result, ctx);
                           console.log("AUTH")
                           console.log(entity.metadata.name)
                           const ownershipRefs = getDefaultOwnershipEntityRefs(entity)
                           if (!entity) {
                               throw new AuthenticationError('Authentication failed', "No user found in catalog");
                           }
                           return ctx.issueToken({
                               claims: {
                                   sub: stringifyEntityRef(entity),
                                   ent: ownershipRefs,
                                   groups: await getGroupDisplayNamesForEntity(ownershipRefs, catalogApi, auth)
                               }
                           })
                       }
                    })
                })
            }
        })
    }
})


const istioProxyAuthenticator = createProxyAuthenticator({
    defaultProfileTransform: async (result: OAuth2ProxyResult) => {
        const authHeader= result.getHeader('authorization');

        if (!authHeader) {
            throw new Error('Request did not contain an authorization header');
        }

        const token = jwtDecode<JwtPayload>(authHeader.split(' ')[1])
        console.log("TOKEN")
        console.log(token)
        const email = <string>( token as any).preferred_username

        if (!email) {
            throw new AuthenticationError('Request did not contain an email');
        }

        return {
            profile: {
                email,
            }
        }
    },
    async initialize() {},
    async authenticate({ req }) {
        try {
        const authHeader= req.header('authorization');

        if (!authHeader) {
            throw new Error('Request did not contain an authorization header');
        }

        const token = jwtDecode<JwtPayload>(authHeader.split(' ')[1])

        const result = {
            fullProfile: token,
            accessToken: authHeader.split(' ')[1] || '',
            headers: req.headers,
            getHeader(name: string) {
                if (name.toLocaleLowerCase('en-US') === 'set-cookie') {
                    throw new Error('Access Set-Cookie via the headers object instead');
                }
                return req.get(name);
            },
        };

        return {
            result,
            providerInfo: {
                accessToken: result.accessToken,
            },
        };
    } catch (e) {
        throw new AuthenticationError('Authentication failed', e);
    }
    }
})

async function getUserFromResult(result: OAuth2ProxyResult, ctx: AuthResolverContext): Promise<Entity> {
    const authHeader= result.getHeader('authorization');

    if (!authHeader) {
        throw new Error('Request did not contain an authorization header');
    }

    const token = jwtDecode<JwtPayload>(authHeader.split(' ')[1])
    const email = <string>( token as any).preferred_username

    if (!email) {
        throw new Error('Request did not contain an email');
    }

    const { entity } = await ctx.findCatalogUser({
        annotations: {
            'microsoft.com/email': email,
        }
    })

    return entity;
}

// Add group display names as claim to the issued backstage token.
// This is used for DASKs onboarding plugin
async function getGroupDisplayNamesForEntity(ownershipRefs: string[], catalogApi: CatalogApi, auth: AuthService): Promise<string[]> {
    const { token } = await auth.getPluginRequestToken({
        onBehalfOf: await auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog', // e.g. 'catalog'
    });
    const groupEntitiesUsingDisplayName = await catalogApi.getEntitiesByRefs({entityRefs: ownershipRefs}, {token: token});
    const groupDisplayNames: string[] = await Promise.all(
        groupEntitiesUsingDisplayName.items
            //@ts-ignore
            .filter(e => e != undefined && e.spec && e.kind == 'Group' && e.spec.profile && e.spec.profile.displayName)
            .map(async e => {
                let parentGroup: Entity | undefined;
                if (e!.spec!.parent) {
                    parentGroup = await catalogApi.getEntityByRef(e!.spec!.parent as string, {token: token});
                }
                let groupName;
                if (parentGroup) {
                    //@ts-ignore
                    groupName = `${parentGroup!.spec!.profile!.displayName}:${e!.spec!.profile!.displayName}`;
                } else {
                    //@ts-ignore
                    groupName = e!.spec!.profile!.displayName;
                }
                return groupName;
            })
    );
    return groupDisplayNames;
}
