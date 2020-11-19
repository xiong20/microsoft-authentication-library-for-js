/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { version } from "../../../package.json";
import { BrokerAuthenticationResult, ServerTelemetryManager, AuthorizationCodeClient, BrokerAuthorizationCodeClient, BrokerRefreshTokenClient, RefreshTokenClient, StringUtils, AuthorizationUrlRequest, PersistentCacheKeys, IdToken, ProtocolUtils, ResponseMode, ScopeSet, AccountInfo } from "@azure/msal-common";
import { BrokerMessage } from "../msg/BrokerMessage";
import { BrokerMessageType, InteractionType } from "../../utils/BrowserConstants";
import { Configuration } from "../../config/Configuration";
import { BrokerHandshakeRequest } from "../msg/req/BrokerHandshakeRequest";
import { BrokerHandshakeResponse } from "../msg/resp/BrokerHandshakeResponse";
import { BrokerAuthRequest } from "../msg/req/BrokerAuthRequest";
import { BrokerRedirectResponse } from "../msg/resp/BrokerRedirectResponse";
import { RedirectRequest } from "../../request/RedirectRequest";
import { BrokerAuthResponse } from "../msg/resp/BrokerAuthResponse";
import { ClientApplication } from "../../app/ClientApplication";
import { PopupRequest } from "../../request/PopupRequest";
import { BrokerHandleRedirectRequest } from "../msg/req/BrokerHandleRedirectRequest";
import { SsoSilentRequest } from "../../request/SsoSilentRequest";
import { BrowserStateObject } from "../../utils/BrowserProtocolUtils";
import { BrokerSilentRequest } from "../request/BrokerSilentRequest";
import { BrokerAuthError } from "../../error/BrokerAuthError";
import { BrokerPopupRequest } from "../request/BrokerPopupRequest";
import { BrokerRedirectRequest } from "../request/BrokerRedirectRequst";

/**
 * Broker Application class to manage brokered requests.
 */
export class BrokerClientApplication extends ClientApplication {

    private cachedBrokerResponse: Promise<BrokerAuthenticationResult>;
    private brokerAccount: AccountInfo;

    constructor(configuration: Configuration) {
        super(configuration);
    }

    /**
     * 
     */
    async handleRedirectPromise(): Promise<BrokerAuthenticationResult | null> {
        this.cachedBrokerResponse = super.handleRedirectPromise() as Promise<BrokerAuthenticationResult>;
        const cachedResponse = (await this.cachedBrokerResponse);
        if (cachedResponse) {
            this.brokerAccount = cachedResponse.account;
            return cachedResponse;
        }
        
        return null;
    }

    /**
     * 
     */
    listenForBrokerMessage(): void {
        window.addEventListener("message", this.handleBrokerMessage.bind(this));
    }

    /**
     * 
     * @param message 
     */
    private async handleBrokerMessage(message: MessageEvent): Promise<void> {
        // Check that message is a BrokerHandshakeRequest
        const clientMessage = BrokerMessage.validateMessage(message);
        if (clientMessage) {
            switch (clientMessage.data.messageType) {
                case BrokerMessageType.HANDSHAKE_REQUEST:
                    this.logger.verbose("Broker handshake request received");
                    return await this.handleBrokerHandshake(clientMessage);
                case BrokerMessageType.HANDLE_REDIRECT_REQUEST:
                    this.logger.verbose("Broker handle redirect request received");
                    return await this.handleBrokerRedirectResponse(clientMessage);
                case BrokerMessageType.AUTH_REQUEST:
                    this.logger.verbose("Broker auth request received");
                    return await this.handleBrokerAuthRequest(clientMessage);
                default:
                    return;
            }
        }
    }

    /* eslint-disable */
    /**
     * Handle a broker handshake request from a child.
     * @param clientMessage 
     */
    private async handleBrokerHandshake(clientMessage: MessageEvent): Promise<void> {
        const validMessage = BrokerHandshakeRequest.validate(clientMessage);
        this.logger.verbose(`Broker handshake validated: ${validMessage}`);
        const brokerHandshakeResponse = new BrokerHandshakeResponse(version, "");

        // @ts-ignore
        clientMessage.source.postMessage(brokerHandshakeResponse, clientMessage.origin);
        this.logger.info(`Sending handshake response: ${brokerHandshakeResponse}`);
    }

    /**
     * 
     * @param clientMessage 
     */
    async handleBrokerRedirectResponse(clientMessage: MessageEvent): Promise<void> {
        const validMessage = BrokerHandleRedirectRequest.validate(clientMessage);
        if (validMessage) {
            // TODO: Calculate request thumbprint
            const clientPort = clientMessage.ports[0];
            const brokerResult = await this.cachedBrokerResponse;
            if (brokerResult) {
                // TODO: Replace with in-memory cache lookup
                this.cachedBrokerResponse = null;
                const brokerAuthResponse: BrokerAuthResponse = new BrokerAuthResponse(InteractionType.Redirect, brokerResult);
                this.logger.info(`Sending auth response: ${brokerAuthResponse}`);
                clientPort.postMessage(brokerAuthResponse);
                clientPort.close();
                return;
            } else {
                // TODO: Throw error or return null?
                clientPort.postMessage(null);
                clientPort.close();
            }
        }
    }

    /**
     * Handle a brokered auth request from the child.
     * @param clientMessage 
     */
    private async handleBrokerAuthRequest(clientMessage: MessageEvent): Promise<void> {
        const validMessage = BrokerAuthRequest.validate(clientMessage);
        if (validMessage) {
            this.logger.verbose(`Broker auth request validated: ${validMessage}`);

            // TODO: Calculate request thumbprint
            const brokerResult = await this.cachedBrokerResponse;
            if (brokerResult && brokerResult.tokensToCache) {
                // TODO: Replace with in-memory cache lookup
                this.cachedBrokerResponse = null;
                const clientPort = clientMessage.ports[0];
                const brokerAuthResponse: BrokerAuthResponse = new BrokerAuthResponse(InteractionType.Redirect, brokerResult);
                this.logger.info(`Sending auth response: ${brokerAuthResponse}`);
                clientPort.postMessage(brokerAuthResponse);
                clientPort.close();
                return;
            }
            if (this.brokerAccount) {
                return this.brokeredSilentRequest(validMessage, clientMessage.ports[0], this.brokerAccount);
            }
            switch (validMessage.interactionType) {
                case InteractionType.Silent:
                    return this.brokeredSilentRequest(validMessage, clientMessage.ports[0], this.brokerAccount);
                case InteractionType.Redirect:
                case InteractionType.Popup:
                default:
                    const interactionType = this.config.system.brokerOptions.preferredInteractionType && this.config.system.brokerOptions.preferredInteractionType !== InteractionType.None 
                        ? this.config.system.brokerOptions.preferredInteractionType : validMessage.interactionType;
                    return this.interactiveBrokerRequest(interactionType, validMessage, clientMessage);
            }
        }
    }

    /**
     * 
     * @param interactionType 
     * @param validMessage 
     * @param clientMessage 
     */
    private async interactiveBrokerRequest(interactionType: InteractionType, validMessage: BrokerAuthRequest, clientMessage: MessageEvent): Promise<void> {
        switch (interactionType) {
            case InteractionType.Redirect:
                return this.brokeredRedirectRequest(validMessage, clientMessage.ports[0]);
            case InteractionType.Popup:
                return this.brokeredPopupRequest(validMessage, clientMessage.ports[0]);
            case InteractionType.Silent:
            case InteractionType.None:
                // TODO: Throw error?
            default:
                return;
        }
    }

    /**
     * Send redirect request as the broker.
     * @param validMessage 
     * @param clientPort 
     */
    private async brokeredRedirectRequest(validMessage: BrokerAuthRequest, clientPort: MessagePort): Promise<void> {
        const brokerRedirectResp = new BrokerRedirectResponse();
        // @ts-ignore
        clientPort.postMessage(brokerRedirectResp);
        clientPort.close();
        this.logger.info(`Sending redirect response: ${brokerRedirectResp}`);

        const redirectRequest = validMessage.request as BrokerRedirectRequest;
        redirectRequest.brokeredClientId = validMessage.embeddedClientId;

        // Call loginRedirect
        this.acquireTokenRedirect(redirectRequest);
    }

    /**
     * Send popup request as the broker.
     * @param validMessage 
     * @param clientPort 
     */
    private async brokeredPopupRequest(validMessage: BrokerAuthRequest, clientPort: MessagePort): Promise<void> {
        try {
            const popupRequest = validMessage.request as BrokerPopupRequest;
            popupRequest.brokeredClientId = validMessage.embeddedClientId;
            const response: BrokerAuthenticationResult = (await this.acquireTokenPopup(popupRequest)) as BrokerAuthenticationResult;
            const brokerAuthResponse: BrokerAuthResponse = new BrokerAuthResponse(InteractionType.Popup, response);
            this.logger.info(`Sending auth response: ${brokerAuthResponse}`);
            clientPort.postMessage(brokerAuthResponse);
            clientPort.close();
        } catch (err) {
            const brokerAuthResponse = new BrokerAuthResponse(InteractionType.Popup, null, err);
            this.logger.info(`Found auth error: ${err}`);
            clientPort.postMessage(brokerAuthResponse);
            clientPort.close();
        }
    }

    /**
     * Send silent renewal request as the broker.
     * @param validMessage 
     * @param clientPort 
     */
    private async brokeredSilentRequest(validMessage: BrokerAuthRequest, clientPort: MessagePort, account?: AccountInfo): Promise<void> {
        try {
            const silentRequest = validMessage.request as BrokerSilentRequest;
            silentRequest.brokeredClientId = validMessage.embeddedClientId;
            silentRequest.brokerRedirectUri = this.getRedirectUri();
            if (!silentRequest.account) {
                silentRequest.account = account;
            }
            const response: BrokerAuthenticationResult = (await this.acquireTokenByRefreshToken(silentRequest)) as BrokerAuthenticationResult;
            const brokerAuthResponse: BrokerAuthResponse = new BrokerAuthResponse(InteractionType.Silent, response);
            if (brokerAuthResponse.result.tokensToCache) {
                this.logger.info(`Sending auth response: ${brokerAuthResponse}`);
                clientPort.postMessage(brokerAuthResponse);
                clientPort.close();
            } else {
                const noTokensErr = BrokerAuthError.createNoTokensToCacheError();
                const brokerAuthResponse = new BrokerAuthResponse(InteractionType.Silent, null, noTokensErr);
                this.logger.info(`${noTokensErr}`);
                clientPort.postMessage(brokerAuthResponse);
                clientPort.close();
            }
        } catch (err) {
            const brokerAuthResponse = new BrokerAuthResponse(InteractionType.Silent, null, err);
            this.logger.info(`Found auth error: ${err}`);
            clientPort.postMessage(brokerAuthResponse);
            clientPort.close();
        }
    }

    /**
     * Creates an Broker Authorization Code Client with the given authority, or the default authority.
     * @param authorityUrl 
     */
    protected async createAuthCodeClient(serverTelemetryManager: ServerTelemetryManager, authorityUrl?: string): Promise<AuthorizationCodeClient> {
        // Create auth module.
        const clientConfig = await this.getClientConfiguration(serverTelemetryManager, authorityUrl);
        
        return new BrokerAuthorizationCodeClient(clientConfig);
    }

    /**
     * Creates a Refresh Client with the given authority, or the default authority.
     * @param authorityUrl 
     */
    protected async createRefreshTokenClient(serverTelemetryManager: ServerTelemetryManager, authorityUrl?: string): Promise<RefreshTokenClient> {
        // Create auth module.
        const clientConfig = await this.getClientConfiguration(serverTelemetryManager, authorityUrl);
        return new BrokerRefreshTokenClient(clientConfig);
    }

    /**
     * Helper to initialize required request parameters for interactive APIs and ssoSilent()
     * @param request
     */
    protected initializeAuthorizationRequest(request: AuthorizationUrlRequest|RedirectRequest|PopupRequest|SsoSilentRequest, interactionType: InteractionType): AuthorizationUrlRequest {
        let validatedRequest: AuthorizationUrlRequest = {
            ...request,
            ...this.setDefaultScopes(request)
        };

        validatedRequest.redirectUri = this.getRedirectUri(validatedRequest.redirectUri);

        // Check for ADAL SSO
        if (StringUtils.isEmpty(validatedRequest.loginHint)) {
            // Only check for adal token if no SSO params are being used
            const adalIdTokenString = this.browserStorage.getTemporaryCache(PersistentCacheKeys.ADAL_ID_TOKEN) as string;
            if (!StringUtils.isEmpty(adalIdTokenString)) {
                const adalIdToken = new IdToken(adalIdTokenString, this.browserCrypto);
                this.browserStorage.removeItem(PersistentCacheKeys.ADAL_ID_TOKEN);
                if (adalIdToken.claims && adalIdToken.claims.upn) {
                    validatedRequest.loginHint = adalIdToken.claims.upn;
                }
            }
        }

        const scopes = new ScopeSet(request.scopes);

        const browserState: BrowserStateObject = {
            interactionType: interactionType,
            brokeredClientId: this.config.auth.clientId,
            brokeredReqAuthority: (request && request.authority) || this.config.auth.authority,
            brokeredReqScopes: scopes.printScopes()
        };

        validatedRequest.state = ProtocolUtils.setRequestState(
            this.browserCrypto,
            (request && request.state) || "",
            browserState
        );

        if (StringUtils.isEmpty(validatedRequest.nonce)) {
            validatedRequest.nonce = this.browserCrypto.createNewGuid();
        }

        validatedRequest.responseMode = ResponseMode.FRAGMENT;

        validatedRequest = {	
            ...validatedRequest,	
            ...this.initializeBaseRequest(validatedRequest)	
        };

        this.browserStorage.updateCacheEntries(validatedRequest.state, validatedRequest.nonce, validatedRequest.authority);

        return validatedRequest;
    }
}