// Cross-origin frames are normally ignored. These established identity/payment hosts are
// the narrow exception because they legitimately embed sign-in UI on customer sites.
globalThis.FAPASSWORD_IFRAME_LOGIN_HOSTS = Object.freeze([
  "accounts.google.com", "adyen.com", "affirm.com", "afterpay.com", "amazon.com", "amazoncognito.com",
  "appleid.apple.com", "atlassian.com", "auth0.com", "authkit.app", "awsapps.com", "b2clogin.com",
  "beyondidentity.com", "cash.app", "ciamlogin.com", "clearpay.co.uk", "clerk.accounts.dev", "clerk.com",
  "corbado.io", "cyberark.cloud", "delinea.app", "descope.com", "descope.io", "discord.com",
  "dropbox.com", "duosecurity.com", "dynamicauth.com", "facebook.com", "finicity.com", "force.com",
  "forgeblocks.com", "forgerock.com", "forgerock.io", "frontegg.com", "fusionauth.io", "github.com",
  "gitlab.com", "hanko.io", "idaptive.app", "jumpcloud.com", "kakao.com", "kinde.com", "klarna.com",
  "line.me", "link.com", "linkedin.com", "live.com", "loginradius.com", "magic.link",
  "microsoftonline.com", "mojoauth.com", "moneydesktop.com", "naver.com", "okta-emea.com", "okta.com",
  "oktapreview.com", "onelogin.com", "openlogin.com", "ory.sh", "oryapis.com", "paypal.com",
  "passport.aliyun.com", "phasetwo.io", "ping-eng.com", "pingidentity.com", "pingone.com", "plaid.com",
  "privy.io", "propelauth.com", "propelauthtest.com", "razorpay.com", "reddit.com", "sailpoint.com",
  "salesforce.com", "secureauth.com", "securid.com", "shop.app", "shopify.com", "slack.com", "spotify.com",
  "stripe.com", "stytch.com", "supertokens.com", "tink.com", "transmitsecurity.io", "truelayer.com",
  "twitch.tv", "twitter.com", "userfront.com", "venmo.com", "verify.ibm.com", "vk.com", "web3auth.io",
  "workos.com", "x.com", "xecurify.com", "yahoo.com", "yandex.com", "yandex.ru", "zitadel.cloud",
]);
