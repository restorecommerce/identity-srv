import { errors } from '@restorecommerce/chassis-srv';
import { Logger } from 'winston';

// validateFirstChar validates the first allowed character in a string
export const validateFirstChar = (string: string, logger: Logger): boolean => {
  const firstChar = string.substring(0, 1);
  const regexp = new RegExp('^[a-zA-ZäöüÄÖÜß]$');
  const errMessage = `Username ${string} is invalid! ` +
    `The first letter should be one of the allowed characters: a-z A-Z or äöüÄÖÜß`;
  if (!!firstChar.match(regexp) == false) {
    logger.error(errMessage);
    throw new errors.InvalidArgument(errMessage);
  } else {
    return true;
  }
};

// validateSymbolRepeat throws an error if it finds repetitions like __, --, ..
export const validateSymbolRepeat = (string: string, logger: Logger): boolean => {
  const regexp = new RegExp('^(?!.*__)(?!.*--)(?!.*\\.\\.).+');
  const errMessage = `Username ${string} is invalid! ` +
    `Character repetitions like __, .., -- are not allowed.`;
  if (!!string.match(regexp) == false) {
    logger.error(errMessage);
    throw new errors.InvalidArgument(errMessage);
  } else {
    return true;
  }
};

// validateAllChar validates the allowed characters in a string
export const validateAllChar = (string: string, logger: Logger): boolean => {
  const regexp = new RegExp('^[a-zA-Z0-9äöüÄÖÜß@_.-]+$');
  const errMessage = `Username ${string} is invalid! ` +
    `Please use only the allowed characters: a-z, A-Z, 0-9, äöüÄÖÜß and @_.- `;
  if (!!string.match(regexp) == false) {
    logger.error(errMessage);
    throw new errors.InvalidArgument(errMessage);
  } else {
    return true;
  }
};

// validateStrLen validates the length of a string
export const validateStrLen = (string: string, minLength: number,
  maxLength: number, logger: Logger): boolean => {
  const errMessage = `Username ${string} is invalid! ` +
    `The username length must be between ${minLength} and ${maxLength} characters!`;
  if (string.length >= minLength && string.length <= maxLength) {
    return true;
  } else {
    logger.error(errMessage);
    throw new errors.InvalidArgument(errMessage);
  }
};

// validateEmail checks if the string input is a valid email
export const validateEmail = (string: string, logger: Logger): boolean => {
  // As per https://www.abstractapi.com/guides/email-validation/email-address-pattern-validation
  /*eslint no-empty-character-class: "warn"*/
  const regexp = new RegExp(/^([-!#-'*+/-9=?A-Z^-~]+(\.[-!#-'*+/-9=?A-Z^-~]+)*|"([]!#-[^-~ \t]|(\\[\t -~]))+")@([0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?(\.[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?)*|\[((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|IPv6:((((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){6}|::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){5}|[0-9A-Fa-f]{0,4}::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){4}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):)?(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){3}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,2}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){2}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,3}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,4}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,5}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,6}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)|(?!IPv6:)[0-9A-Za-z-]*[0-9A-Za-z]:[!-Z^-~]+)])$/);
  const errMessage = `Username ${string} is not a valid email!`;
  if (!!string.match(regexp) == false) {
    logger.error(errMessage);
    throw new errors.InvalidArgument(errMessage);
  } else {
    return true;
  }
};
