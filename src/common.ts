import * as _ from 'lodash';
import { UserService } from './service';
import { FindByTokenRequest } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth';

/**
 * reads metadata from DB and updates owner information in resource if action is UPDATE / DELETE
 */
export const createMetadata = async (res: any, urns: any, userService: UserService, subject?: Subject): Promise<any> => {
  let resources = _.cloneDeep(res);
  if (!Array.isArray(resources)) {
    resources = [resources];
  }

  let orgOwnerAttributes = [];
  for (let resource of resources) {
    if (!resource.meta) {
      resource.meta = {};
    }
    if (subject && subject.id) {
      orgOwnerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.user,
          attributes: [{
            id: urns.ownerInstance,
            value: subject.id
          }]
        }
      );
    } else if (subject && subject.token) {
      // when no subjectID is provided find the subjectID using findByToken
      const user = await userService.findByToken(FindByTokenRequest.fromPartial({ token: subject.token }), context);
      if (user && user.payload && user.payload.id) {
        orgOwnerAttributes.push(
          {
            id: urns.ownerIndicatoryEntity,
            value: urns.user,
            owners: [{
              id: urns.ownerInstance,
              value: user.payload.id
            }]
          });
      }
    }
    resource.meta.owners = orgOwnerAttributes;
  }

  return resources;
};
